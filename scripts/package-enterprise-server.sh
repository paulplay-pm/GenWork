#!/usr/bin/env bash
#
# package-enterprise-server.sh
# ----------------------------
# One-shot packaging for the enterprise_server Docker image.
#
# Usage:
#   scripts/package-enterprise-server.sh [--registry <host/path>] [--tag <tag>]
#                                        [--platform <csv>] [--push|--load-only]
#                                        [--env-file <path>] [--generate-secrets]
#                                        [-h|--help]
#
# What it does:
#   1. Pre-flight: docker / buildx / git available, repo root detected.
#   2. Resolve the final image tag (`<registry>/enterprise-server:<version>-<sha>`
#      by default; registry defaults to `enterprise-server` so the resulting
#      image matches `IMAGE_REPO=enterprise-server` expected by
#      `genwork-server upgrade`).
#   3. Optionally auto-generate JWT_SECRET / GENWORK_VAULT_MASTER_KEY via
#      `openssl rand` and write them into a build-only .env that the
#      Dockerfile does NOT see. (Secrets stay in your .env; the image bakes
#      only VERSION.)
#   4. Run `docker buildx build` with the three-stage Dockerfile at
#      `enterprise_server/Dockerfile`:
#        - web-build  → npm ci + vite build (SPA → web-dist)
#        - ts-build   → npm ci + tsc      (server → dist)
#        - runtime    → prod-only deps, tini, node user, HEALTHCHECK
#   5. Either `--load` the result into the local docker daemon (default), or
#      `--push` directly to the registry, or `--load-only` (skip buildx's
#      manifest-list step when you only want a single-arch local image).
#   6. Print the exact `docker compose` / `docker run` commands the operator
#      needs to start the image on the server.
#
# This script complements (does not replace) `scripts/build-enterprise-image.sh`,
# which is the minimal "just buildx + sha tag" entry point used by CI. This one
# adds: registry selection, multi-arch, secret handling guidance, env validation,
# and a copy-pasteable next-step hint.

set -euo pipefail

# --------------------------------------------------------------------------
# Argument parsing
# --------------------------------------------------------------------------
REGISTRY="${REGISTRY:-}"        # e.g. registry.internal/genwork  or  docker.io/yourorg
TAG="${TAG:-}"                  # version segment, e.g. v2026.10.19
PLATFORM="${PLATFORM:-}"        # csv, e.g. linux/amd64,linux/arm64
PUSH=0
LOAD_ONLY=0
ENV_FILE_PATH=""
GENERATE_SECRETS=0
EXTRA_BUILDX_ARGS=()

print_help() {
  sed -n '2,40p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --registry)        REGISTRY="$2"; shift 2 ;;
    --tag)             TAG="$2"; shift 2 ;;
    --platform)        PLATFORM="$2"; shift 2 ;;
    --push)            PUSH=1; shift ;;
    --load-only)       LOAD_ONLY=1; shift ;;
    --env-file)        ENV_FILE_PATH="$2"; shift 2 ;;
    --generate-secrets) GENERATE_SECRETS=1; shift ;;
    -h|--help)         print_help ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# --------------------------------------------------------------------------
# Pre-flight
# --------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/enterprise_server/Dockerfile"
ES_DIR="$REPO_ROOT/enterprise_server"
ES_WEB_DIR="$ES_DIR/web"

[[ -f "$DOCKERFILE" ]] || { echo "[package] Dockerfile not found at $DOCKERFILE" >&2; exit 1; }
command -v docker >/dev/null || { echo "[package] docker not on PATH" >&2; exit 1; }
docker buildx version >/dev/null 2>&1 || { echo "[package] docker buildx not available" >&2; exit 1; }

# --------------------------------------------------------------------------
# Ensure enterprise_server/web/package-lock.json exists.
#
# enterprise_server/web is NOT a workspace — it's a standalone npm project
# with its own lockfile. The Dockerfile's web-build stage does
#   COPY enterprise_server/web/package.json enterprise_server/web/package-lock.json* ./
#   RUN npm ci --no-audit --no-fund --ignore-scripts
# and `npm ci` refuses to run without a real lockfile (EUSAGE).
#
# enterprise_server itself is an npm workspace of the repo root, so its
# dependency lock lives at the root package-lock.json (the Dockerfile
# installs from there). No per-workspace lock is needed for it.
# --------------------------------------------------------------------------
if [[ -f "$ES_WEB_DIR/package.json" && ! -f "$ES_WEB_DIR/package-lock.json" ]]; then
  echo "[package] enterprise_server/web: package-lock.json missing — generating (no install)..."
  (
    cd "$ES_WEB_DIR"
    # --package-lock-only writes the lock without touching node_modules.
    # --ignore-scripts skips install hooks (no native compile).
    npm install --package-lock-only --no-audit --no-fund --ignore-scripts --no-workspaces \
      >/tmp/npmlock.$$.log 2>&1 || {
        echo "[package] enterprise_server/web: lock generation failed. Last log lines:" >&2
        tail -n 20 /tmp/npmlock.$$.log >&2
        rm -f /tmp/npmlock.$$.log
        exit 1
      }
  ) || exit 1
  rm -f /tmp/npmlock.$$.log
  [[ -f "$ES_WEB_DIR/package-lock.json" ]] || {
    echo "[package] enterprise_server/web: npm reported success but no package-lock.json was written." >&2
    exit 1
  }
fi

# --------------------------------------------------------------------------
# Resolve the image tag
# --------------------------------------------------------------------------
# OCI image tags may NOT contain '+' (docker push refuses); we use '-' for the
# git sha suffix, matching the convention in scripts/build-enterprise-image.sh
# and README_zh.md §4.4.
TAG_PATTERN='^[a-zA-Z0-9._-]+$'

if [[ -z "$TAG" ]]; then
  TAG="dev"
fi
if ! [[ "$TAG" =~ $TAG_PATTERN ]]; then
  echo "[package] invalid --tag '$TAG'; allowed chars [a-zA-Z0-9._-]" >&2
  exit 2
fi

if command -v git >/dev/null && git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  SHA="$(git -C "$REPO_ROOT" rev-parse --short HEAD)"
  FULL_TAG="${TAG}-${SHA}"
else
  SHA=""
  FULL_TAG="$TAG"
fi

if ! [[ "$FULL_TAG" =~ $TAG_PATTERN ]]; then
  echo "[package] computed tag '$FULL_TAG' contains illegal chars" >&2
  exit 2
fi

# Image name. With no --registry flag we emit `enterprise-server:v...` so
# the resulting image matches the IMAGE_REPO=enterprise-server default
# that both docker-compose.yml and `genwork-server upgrade` expect. Pass
# --registry registry.internal/genwork (or similar) when pushing to a
# real registry.
REGISTRY="${REGISTRY:-}"
IMAGE="enterprise-server:${FULL_TAG}"
if [[ -n "$REGISTRY" ]]; then
  REGISTRY="${REGISTRY%/}"
  IMAGE="${REGISTRY}/enterprise-server:${FULL_TAG}"
fi

echo "[package] image       = ${IMAGE}"
if [[ -n "$PLATFORM" ]]; then
  echo "[package] platforms   = ${PLATFORM}"
fi

# --------------------------------------------------------------------------
# Optional: generate JWT_SECRET / GENWORK_VAULT_MASTER_KEY into a build-only
# .env. The Dockerfile does NOT receive them — these are written next to the
# script and only used to seed a real `.env` on the server. The image itself
# stays secret-free; secrets are provided at runtime via `docker run -e` or
# `env_file:` in compose.
# --------------------------------------------------------------------------
if [[ $GENERATE_SECRETS -eq 1 ]]; then
  command -v openssl >/dev/null || { echo "[package] openssl not on PATH" >&2; exit 1; }
  SECRET_OUT="${ENV_FILE_PATH:-$REPO_ROOT/enterprise_server/.env.generated}"
  JWT_SECRET_NEW="$(openssl rand -hex 32)"
  VAULT_KEY_NEW="$(openssl rand -base64 32)"
  {
    echo "# Generated by scripts/package-enterprise-server.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# These are SUGGESTED secrets. Review, then move into your real .env on the server."
    echo "JWT_SECRET=${JWT_SECRET_NEW}"
    echo "GENWORK_VAULT_MASTER_KEY=${VAULT_KEY_NEW}"
  } > "$SECRET_OUT"
  chmod 600 "$SECRET_OUT"
  echo "[package] generated secrets → $SECRET_OUT (chmod 600)"
  echo "[package] review them, then merge into your server-side .env"
fi

# --------------------------------------------------------------------------
# Build invocation
#
# Default: DOCKER_BUILDKIT=0 (legacy builder) to avoid docker-desktop
# buildkit's persistent frontend-fs cache, which can hold stale "result
# refs" that prevent any first-time successful build on a fresh clone
# (e.g. cache key ld8iz7lomz3vqpyrbgzpxqubr claiming /work/web/dist does
# not exist). The legacy builder uses the docker daemon's image cache and
# is not affected. CI runners, Linux hosts, and clean docker installs do
# not have this issue — pass USE_BUILDKIT=1 (or any non-empty value) to
# opt back into buildkit's speed and per-stage caching.
# --------------------------------------------------------------------------
USE_BUILDKIT="${USE_BUILDKIT:-}"
BUILDER_CMD="docker build"
if [[ -n "$USE_BUILDKIT" ]]; then
  BUILDER_CMD="docker buildx build"
fi

BUILDX_ARGS=(
  --file "$DOCKERFILE"
  --build-arg "VERSION=${FULL_TAG}"
  --tag "$IMAGE"
)

if [[ -n "$PLATFORM" ]]; then
  BUILDX_ARGS+=(--platform "$PLATFORM")
fi

case "$PUSH$LOAD_ONLY" in
  10) BUILDX_ARGS+=(--push) ;;                # --push: ship to registry directly (buildkit only)
  01) ;;                                      # --load-only: no-op for legacy
  *)  [[ -n "$USE_BUILDKIT" ]] && BUILDX_ARGS+=(--load) ;;  # buildkit needs --load; legacy auto-loads
esac

# Bake context from repo root so COPY enterprise_server/... paths resolve.
echo "[package] builder     = $([[ -n "$USE_BUILDKIT" ]] && echo buildkit || echo legacy)"
echo "[package] ${BUILDER_CMD} ${BUILDX_ARGS[*]} $REPO_ROOT"
if [[ -n "$USE_BUILDKIT" ]]; then
  ( cd "$REPO_ROOT" && docker buildx build "${BUILDX_ARGS[@]}" "$REPO_ROOT" )
else
  ( cd "$REPO_ROOT" && DOCKER_BUILDKIT=0 docker build "${BUILDX_ARGS[@]}" "$REPO_ROOT" )
fi

# --------------------------------------------------------------------------
# Post-build hints
# --------------------------------------------------------------------------
# Use a single-quoted heredoc (<<'EOF') so backticks in the hint text are
# not interpreted as command substitution. Then sed-substitute placeholders
# so the operator sees the actual image name / version they just built.
# --------------------------------------------------------------------------
HINT_REGISTRY="${REGISTRY:-enterprise-server}"
cat <<EOF | sed \
    -e "s|__IMAGE__|${IMAGE}|g" \
    -e "s|__ES_DIR__|${ES_DIR}|g" \
    -e "s|__REGISTRY__|${HINT_REGISTRY}|g" \
    -e "s|__FULL_TAG__|${FULL_TAG}|g"

[package] done.

Next steps:

  1) Verify locally (image ENTRYPOINT is the CLI directly — do NOT prefix with 'genwork-server'):
       docker run --rm __IMAGE__ version
       docker run --rm __IMAGE__ help

  2) Smoke test the production entrypoint (dry-run migrations, no DB writes):
       docker run --rm --env-file __ES_DIR__/.env \\
           -e GENWORK_MIGRATE_DRY_RUN=1 __IMAGE__ migrate

  3) Start the server (uses the local docker daemon; IMAGE_REPO matches the
     default in docker-compose.yml):
       IMAGE_REPO=__REGISTRY__ IMAGE_TAG=__FULL_TAG__ \\
           docker compose -f __ES_DIR__/docker-compose.yml up -d
       curl -fsS http://127.0.0.1:8787/health

  4) Push to a registry (if you did not pass --push):
       docker push __IMAGE__

  5) On the production host, rolling upgrade via the CLI. The CLI reads
     IMAGE_REPO from /etc/genwork/.env (defaults to 'enterprise-server'),
     so make sure the host's IMAGE_REPO matches the image name you built
     above — usually a registry path like registry.example.com/genwork:
       genwork-server upgrade --to __FULL_TAG__
EOF