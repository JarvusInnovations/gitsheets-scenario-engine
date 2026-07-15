#!/usr/bin/env bash
# Demo client: log in (fork a session), drive the order state machine
# (pending -> accepted -> in-progress -> completed) through the dual-mode
# facade, then clone the session's complete causal history off the running
# server — the demo-world plan's worked example of
# specs/scenario-engine.md's request=commit discipline and
# specs/facade.md's git exposure.
#
# Requires: curl, jq, git, and a running server (`bun run dev`, or
# `bun run start` after setting env — see .env.example).
#
# Usage:
#   scripts/demo.sh
#   BASE_URL=http://127.0.0.1:3001 SCENARIO=rush-hour ORDER_ID=order-2001 scripts/demo.sh
#   GIT_EXPOSURE_TOKEN=... scripts/demo.sh   # clones over the git-exposure endpoint
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3001}"
SCENARIO="${SCENARIO:-standard-day}"
ORDER_ID="${ORDER_ID:-order-1001}"
# Only needed for the "no GIT_EXPOSURE_TOKEN set" fallback clone at the end
# — must match the server's RUNTIME_REPO_PATH (see .env.example).
RUNTIME_REPO_PATH="${RUNTIME_REPO_PATH:-var/runtime.git}"

step() { printf '\n==> %s\n' "$1"; }

step "Logging in (forking a session from scenario '$SCENARIO')"
LOGIN_RESPONSE=$(curl -sf -X POST "$BASE_URL/session/login" \
  -H 'content-type: application/json' \
  -d "{\"scenario\": \"$SCENARIO\"}")
echo "$LOGIN_RESPONSE" | jq .
SESSION_KEY=$(echo "$LOGIN_RESPONSE" | jq -r '.sessionKey')
if [ -z "$SESSION_KEY" ] || [ "$SESSION_KEY" = "null" ]; then
  echo "login failed — is the server running at $BASE_URL, and does scenario '$SCENARIO' exist?" >&2
  exit 1
fi

step "GET /orders/$ORDER_ID (dual route — offline by deployment default)"
curl -sf "$BASE_URL/orders/$ORDER_ID" -H "x-session-key: $SESSION_KEY" | jq .

step "POST /orders/$ORDER_ID/accept  (pending -> accepted; assigns a courier)"
curl -sf -X POST "$BASE_URL/orders/$ORDER_ID/accept" -H "x-session-key: $SESSION_KEY" | jq .

step "POST /orders/$ORDER_ID/start  (accepted -> in-progress)"
curl -sf -X POST "$BASE_URL/orders/$ORDER_ID/start" -H "x-session-key: $SESSION_KEY" | jq .

step "POST /orders/$ORDER_ID/complete  (in-progress -> completed; frees the courier)"
curl -sf -X POST "$BASE_URL/orders/$ORDER_ID/complete" -H "x-session-key: $SESSION_KEY" | jq .

step "GET /orders/$ORDER_ID/notifications  (the state machine's simulated side effects)"
curl -sf "$BASE_URL/orders/$ORDER_ID/notifications" -H "x-session-key: $SESSION_KEY" | jq .

step "GET /couriers/alex/upstream  (online-only route — no session needed)"
curl -sf "$BASE_URL/couriers/alex/upstream" | jq .

step "Cloning the session's complete causal history"
CLONE_DIR=$(mktemp -d)
if [ -n "${GIT_EXPOSURE_TOKEN:-}" ]; then
  echo "    via the git-exposure endpoint ($BASE_URL/git)"
  git -c "http.extraHeader=Authorization: Bearer $GIT_EXPOSURE_TOKEN" \
    clone --mirror -q "$BASE_URL/git" "$CLONE_DIR"
else
  echo "    GIT_EXPOSURE_TOKEN not set — cloning the runtime repo directly ($RUNTIME_REPO_PATH)"
  echo "    (set GIT_EXPOSURE_TOKEN to exercise the read-only smart-HTTP endpoint instead)"
  git clone --mirror -q "$RUNTIME_REPO_PATH" "$CLONE_DIR"
fi

echo "    cloned session ref: refs/sessions/$SESSION_KEY"
git --git-dir="$CLONE_DIR" log --first-parent --format='      %h %s' "refs/sessions/$SESSION_KEY"

echo
echo "This is the complete causal log for the demo: every request, its"
echo "response, and every record mutation, traceable through the fork's"
echo "second-parent edge to the exact scenario baseline this build shipped."
