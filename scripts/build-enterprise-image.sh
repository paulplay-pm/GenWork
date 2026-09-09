#!/usr/bin/env bash
# Build the enterprise-server image locally. Honors --version and --push.
# Default version is git describe (short SHA) or "dev".
set -euo pipefail

VERSION="0.1.0"
PUSH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --push)    PUSH="--push"; shift ;;
    *) echo "Unknown arg: $1"; exit 2 ;;
  esac
done

if command -v git >/dev/null && git rev-parse --git-dir >/dev/null 2>&1; then
  SHA=$(git rev-parse --short HEAD)
  # Dash-separated (not '+') because OCI image tags may not contain '+'.
  VERSION="${VERSION}-${SHA}"
fi

echo "Building enterprise-server:${VERSION}"
docker buildx build \
  -f enterprise_server/Dockerfile \
  --build-arg "VERSION=${VERSION}" \
  --tag "enterprise-server:${VERSION}" \
  ${PUSH} \
  --load \
  .
