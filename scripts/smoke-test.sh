#!/usr/bin/env bash
# Smoke test for the CTF Slack clone.
#
# Boots the server on a random port, exercises the REST + admin surface,
# and verifies the Socket.io client asset and HTML pages are served.
#
# Exits non-zero on the first failure.

set -euo pipefail

PORT="${PORT:-3199}"
ADMIN_TOKEN="${ADMIN_TOKEN:-ci-test-token}"
DATA_DIR="$(mktemp -d)"
COOKIE_JAR="$(mktemp)"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${DATA_DIR}" "${COOKIE_JAR}"
}
trap cleanup EXIT

echo "==> Starting server on :${PORT} (DATA_DIR=${DATA_DIR})"
PORT="${PORT}" ADMIN_TOKEN="${ADMIN_TOKEN}" DATA_DIR="${DATA_DIR}" \
  node server.js >/tmp/server.log 2>&1 &
SERVER_PID=$!

# Wait for /api/health
for i in {1..40}; do
  if curl -fsS "${BASE}/api/health" >/dev/null 2>&1; then
    echo "==> Server up after ${i} attempts"
    break
  fi
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    echo "!! Server exited early. Log:"
    cat /tmp/server.log
    exit 1
  fi
  sleep 0.25
done

if ! curl -fsS "${BASE}/api/health" >/dev/null; then
  echo "!! Server failed to become healthy. Log:"
  cat /tmp/server.log
  exit 1
fi

assert_status() {
  local expected="$1"; shift
  local desc="$1"; shift
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [[ "${code}" != "${expected}" ]]; then
    echo "!! ${desc}: expected ${expected}, got ${code}"
    return 1
  fi
  echo "  ok  ${desc} (${code})"
}

assert_json_field() {
  local field="$1"; shift
  local desc="$1"; shift
  local body
  body=$(curl -fsS "$@")
  if ! node -e "const j=JSON.parse(process.argv[1]); if(!j${field}) process.exit(1)" "${body}"; then
    echo "!! ${desc}: missing field ${field} in ${body}"
    return 1
  fi
  echo "  ok  ${desc}"
}

echo "==> Public endpoints"
assert_status 200 "GET /api/health" "${BASE}/api/health"
assert_status 200 "GET / (login page)" "${BASE}/"
assert_status 200 "GET /admin"        "${BASE}/admin"
assert_status 200 "GET /css/slack.css" "${BASE}/css/slack.css"
assert_status 200 "GET /js/app.js"     "${BASE}/js/app.js"
assert_status 200 "GET /socket.io/socket.io.js" "${BASE}/socket.io/socket.io.js"

echo "==> Auth required when no cookie"
assert_status 401 "GET /api/me without cookie" "${BASE}/api/me"

echo "==> Login"
assert_json_field ".user.id" "POST /api/auth/login" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"username":"alex","displayName":"Alex Hunter"}' \
  -c "${COOKIE_JAR}" "${BASE}/api/auth/login"

echo "==> Authenticated routes"
assert_json_field ".workspace.id" "GET /api/me with cookie" \
  -b "${COOKIE_JAR}" "${BASE}/api/me"

CHANNELS=$(curl -fsS -b "${COOKIE_JAR}" "${BASE}/api/channels")
GENERAL_ID=$(node -e "const j=JSON.parse(process.argv[1]); const c=j.channels.find(x=>x.name==='general'); if(!c) process.exit(1); console.log(c.id)" "${CHANNELS}")
echo "  ok  GET /api/channels -> general=${GENERAL_ID}"

echo "==> Admin auth"
assert_status 403 "POST /api/admin/personas without token" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"username":"ceo"}' "${BASE}/api/admin/personas"

assert_json_field ".persona.isBot" "POST /api/admin/personas" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{"username":"ceo","displayName":"Pat Morgan","persona":"You are the CEO."}' \
  "${BASE}/api/admin/personas"

assert_json_field ".message.id" "POST /api/admin/post" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{"channel":"general","username":"ceo","body":"Hello team!"}' \
  "${BASE}/api/admin/post"

echo "==> Channel messages"
MSGS=$(curl -fsS -b "${COOKIE_JAR}" "${BASE}/api/channels/${GENERAL_ID}/messages?limit=10")
node -e "const j=JSON.parse(process.argv[1]); if(!j.messages.some(m=>m.body==='Hello team!')) process.exit(1)" "${MSGS}"
echo "  ok  GET /api/channels/:id/messages contains posted message"

echo "==> Scenario CRUD + run"
SC_DEF='{"personas":[{"username":"bot1","displayName":"Bot One","persona":"Be terse."}],"events":[{"delay_ms":0,"channel":"general","username":"bot1","body":"scenario hello"}]}'
SC_ID=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d "{\"name\":\"smoke\",\"description\":\"\",\"definition\":${SC_DEF}}" \
  "${BASE}/api/admin/scenarios" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).id)})")
echo "  ok  POST /api/admin/scenarios -> ${SC_ID}"

curl -fsS -X POST -H "x-admin-token: ${ADMIN_TOKEN}" \
  "${BASE}/api/admin/scenarios/${SC_ID}/run" >/dev/null
echo "  ok  POST /api/admin/scenarios/:id/run"

# Wait for scenario event to be posted (delay_ms=0)
for i in {1..20}; do
  MSGS=$(curl -fsS -b "${COOKIE_JAR}" "${BASE}/api/channels/${GENERAL_ID}/messages?limit=20")
  if node -e "const j=JSON.parse(process.argv[1]); process.exit(j.messages.some(m=>m.body==='scenario hello')?0:1)" "${MSGS}"; then
    echo "  ok  scenario event arrived in #general"
    break
  fi
  sleep 0.25
done
node -e "const j=JSON.parse(process.argv[1]); if(!j.messages.some(m=>m.body==='scenario hello')) process.exit(1)" "${MSGS}"

echo "==> Active scenario load/unload"
curl -fsS -X POST -H "x-admin-token: ${ADMIN_TOKEN}" \
  "${BASE}/api/admin/scenarios/${SC_ID}/load" >/dev/null
echo "  ok  POST /api/admin/scenarios/:id/load"

STATE=$(curl -fsS -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/api/admin/state")
node -e "const j=JSON.parse(process.argv[1]); if(!j.activeScenario||j.activeScenario.id!==process.argv[2]) process.exit(1)" "${STATE}" "${SC_ID}"
echo "  ok  GET /api/admin/state shows active scenario"

curl -fsS -X POST -H "x-admin-token: ${ADMIN_TOKEN}" \
  "${BASE}/api/admin/scenarios/unload" >/dev/null
STATE=$(curl -fsS -H "x-admin-token: ${ADMIN_TOKEN}" "${BASE}/api/admin/state")
node -e "const j=JSON.parse(process.argv[1]); if(j.activeScenario) process.exit(1)" "${STATE}"
echo "  ok  POST /api/admin/scenarios/unload clears active"

echo "==> GitHub sync input validation"
assert_status 400 "POST /api/admin/github/sync with no repo" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{}' "${BASE}/api/admin/github/sync"

assert_status 400 "POST /api/admin/github/sync with no token" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{"repo":"acme/scenarios"}' "${BASE}/api/admin/github/sync"

curl -fsS -X DELETE -H "x-admin-token: ${ADMIN_TOKEN}" \
  "${BASE}/api/admin/scenarios/${SC_ID}" >/dev/null
echo "  ok  DELETE /api/admin/scenarios/:id"

echo "==> All smoke tests passed"
