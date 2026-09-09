#!/usr/bin/env bash
# scripts/bootstrap-demo.sh
#
# Idempotently seed a demo enterprise server dataset:
#   - org: default-org (already created by `npm run init`)
#   - users: alice (regular), bob (regular)
#   - provider key: openai placeholder
#   - models: gpt-4o, gpt-4o-mini (with quotas)
#   - skill policy: web-search, org-wide
#
# Usage:
#   export ENTERPRISE_SERVER_URL=http://localhost:8787
#   export ENTERPRISE_BOOTSTRAP_PASSWORD='alice12345' 'bob12345'
#   ./scripts/bootstrap-demo.sh
#
# Re-running is safe: it skips rows that already exist (uses ON CONFLICT).
#
# Requires the Super Admin (created by `npm run init`) to have logged in
# first so we can obtain a JWT. We obtain the JWT by logging in as
# ENTERPRISE_BOOTSTRAP_SUPER_USERNAME / PASSWORD.

set -euo pipefail

if [[ -z "${ENTERPRISE_SERVER_URL:-}" ]]; then
  echo "ENTERPRISE_SERVER_URL is required (e.g. http://localhost:8787)"
  exit 1
fi
SUPER_USER="${ENTERPRISE_BOOTSTRAP_SUPER_USERNAME:-paul}"
SUPER_PASS="${ENTERPRISE_BOOTSTRAP_SUPER_PASSWORD:-P2a0u0l0!}"
ORG_ID="${ENTERPRISE_BOOTSTRAP_ORG_ID:-default-org}"
ALICE_PASS="${ENTERPRISE_BOOTSTRAP_ALICE_PASSWORD:-alice12345}"
BOB_PASS="${ENTERPRISE_BOOTSTRAP_BOB_PASSWORD:-bob12345}"
OPENAI_KEY="${ENTERPRISE_BOOTSTRAP_OPENAI_KEY:-sk-REPLACE-ME}"

login() {
  local user="$1" pass="$2"
  curl -fsS -X POST "$ENTERPRISE_SERVER_URL/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"username\":\"$user\",\"password\":\"$pass\"}" \
    | python3 -c 'import sys, json; print(json.load(sys.stdin)["token"])'
}

echo "[1/5] login as $SUPER_USER"
TOKEN=$(login "$SUPER_USER" "$SUPER_PASS")
H_AUTH="Authorization: Bearer $TOKEN"

upsert_user() {
  local username="$1" password="$2"
  curl -fsS -X POST "$ENTERPRISE_SERVER_URL/admin/users" \
    -H "$H_AUTH" -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"username\":\"$username\",\"password\":\"$password\",\"extraRoles\":[\"user\"]}" \
    >/dev/null 2>&1 && echo "  + user $username" || echo "  ~ user $username (exists)"
}

echo "[2/5] seed users"
upsert_user alice "$ALICE_PASS"
upsert_user bob "$BOB_PASS"

echo "[3/5] add provider key"
PROVIDER_KEY_RESPONSE=$(curl -fsS -X POST "$ENTERPRISE_SERVER_URL/admin/provider-keys" \
  -H "$H_AUTH" -H "Content-Type: application/json" \
  -d "{\"orgId\":\"$ORG_ID\",\"provider\":\"openai\",\"apiKey\":\"$OPENAI_KEY\",\"label\":\"demo\",\"endpoint\":\"https://api.openai.com/v1\"}")
KEY_ID=$(echo "$PROVIDER_KEY_RESPONSE" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "  provider_key id=$KEY_ID"

echo "[4/5] add models"
for MODEL in "gpt-4o:100000:GPT-4o" "gpt-4o-mini:200000:GPT-4o mini"; do
  IFS=':' read -r NAME QUOTA LABEL <<<"$MODEL"
  curl -fsS -X POST "$ENTERPRISE_SERVER_URL/admin/models" \
    -H "$H_AUTH" -H "Content-Type: application/json" \
    -d "{\"orgId\":\"$ORG_ID\",\"providerKeyId\":\"$KEY_ID\",\"provider\":\"openai\",\"model\":\"$NAME\",\"displayName\":\"$LABEL\",\"quotaPerDay\":$QUOTA}" \
    >/dev/null && echo "  + model $NAME"
done

echo "[5/5] add skill policy"
curl -fsS -X POST "$ENTERPRISE_SERVER_URL/admin/policies/skill" \
  -H "$H_AUTH" -H "Content-Type: application/json" \
  -d '{"orgId":"'"$ORG_ID"'","skillId":"web-search","scope":"org-wide"}' \
  >/dev/null && echo "  + skill policy web-search" || true

echo ""
echo "demo dataset seeded. Try logging in as alice / $ALICE_PASS in the desktop app."