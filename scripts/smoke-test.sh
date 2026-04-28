#!/usr/bin/env bash
# Smoke test for the CTF Slack clone.
#
# Boots the server on a random port, exercises the REST + admin surface,
# walks through the cohort flow end-to-end, and verifies the static assets
# and Socket.io client are served.
#
# Exits non-zero on the first failure.

set -euo pipefail

PORT="${PORT:-3199}"
ADMIN_TOKEN="${ADMIN_TOKEN:-ci-test-token}"
DATA_DIR="$(mktemp -d)"
COOKIE_JAR="$(mktemp)"
ADMIN_JAR="$(mktemp)"
BASE="http://127.0.0.1:${PORT}"

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  rm -rf "${DATA_DIR}" "${COOKIE_JAR}" "${ADMIN_JAR}"
}
trap cleanup EXIT

echo "==> Starting server on :${PORT} (DATA_DIR=${DATA_DIR})"
PORT="${PORT}" ADMIN_TOKEN="${ADMIN_TOKEN}" DATA_DIR="${DATA_DIR}" \
  node server.js >/tmp/server.log 2>&1 &
SERVER_PID=$!

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

# Helpers
admin() { curl -fsS -H "x-admin-token: ${ADMIN_TOKEN}" "$@"; }
adminJSON() { curl -fsS -H 'Content-Type: application/json' -H "x-admin-token: ${ADMIN_TOKEN}" "$@"; }
me() { curl -fsS -b "${COOKIE_JAR}" "$@"; }

echo "==> Public assets"
assert_status 200 "GET /api/health"            "${BASE}/api/health"
assert_status 200 "GET / (login)"              "${BASE}/"
assert_status 200 "GET /admin"                 "${BASE}/admin"
assert_status 200 "GET /scoreboard"            "${BASE}/scoreboard"
assert_status 200 "GET /css/slack.css"         "${BASE}/css/slack.css"
assert_status 200 "GET /js/app.js"             "${BASE}/js/app.js"
assert_status 200 "GET /js/emojis.js"          "${BASE}/js/emojis.js"
assert_status 200 "GET /js/scoreboard.js"      "${BASE}/js/scoreboard.js"
assert_status 200 "GET /socket.io/socket.io.js" "${BASE}/socket.io/socket.io.js"

echo "==> Auth required"
assert_status 401 "GET /api/me without cookie" "${BASE}/api/me"

echo "==> Login as alex"
LOGIN=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -d '{"username":"alex","displayName":"Alex Hunter"}' \
  -c "${COOKIE_JAR}" "${BASE}/api/auth/login")
node -e "const j=JSON.parse(process.argv[1]); if(!j.user.id) process.exit(1); if(j.cohort) process.exit(2)" "${LOGIN}"
echo "  ok  POST /api/auth/login (no cohort yet)"

ALEX_ID=$(node -e "console.log(JSON.parse(process.argv[1]).user.id)" "${LOGIN}")

echo "==> Pre-cohort participant has no channels"
CHANS=$(me "${BASE}/api/channels")
node -e "const j=JSON.parse(process.argv[1]); if(j.channels.length!==0) process.exit(1)" "${CHANS}"
echo "  ok  GET /api/channels is empty before joining a cohort"

echo "==> Admin: create scenario"
SC_PAYLOAD="$(mktemp)"
node -e '
  const def = {
    personas: [{ username: "soc-analyst", displayName: "Jordan (SOC)", persona: "You are Jordan." }],
    instructions: {
      title: "Welcome to SOC Triage",
      body: "Reply to Jordan in DM.",
      links: [{ label: "Chronicle", url: "https://chronicle.security/" }]
    },
    tasks: [{
      id: "t1",
      asks: "soc-analyst",
      trigger: "start",
      prompt: "What ATT&CK technique was used? (sub-technique OK)",
      answer: { type: "regex", pattern: "^T1566(\\.[0-9]+)?$", case_insensitive: true },
      points: 100,
      first_blood_bonus: 25,
      on_correct: { reply: "Correct.", next: "t2" },
      on_wrong:   { reply: "Try again." }
    }]
  };
  process.stdout.write(JSON.stringify({ name: "smoke", description: "smoke", definition: def }));
' > "${SC_PAYLOAD}"
SC_ID=$(adminJSON -X POST --data-binary "@${SC_PAYLOAD}" \
  "${BASE}/api/admin/scenarios" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).id)})")
rm -f "${SC_PAYLOAD}"
echo "  ok  POST /api/admin/scenarios -> ${SC_ID}"

echo "==> Admin: create cohort"
COH_BODY=$(adminJSON -X POST \
  -d "{\"name\":\"Smoke Cohort\",\"scenarioId\":\"${SC_ID}\"}" \
  "${BASE}/api/admin/cohorts")
COH_ID=$(node -e "console.log(JSON.parse(process.argv[1]).cohort.id)" "${COH_BODY}")
JOIN_CODE=$(node -e "console.log(JSON.parse(process.argv[1]).cohort.joinCode)" "${COH_BODY}")
echo "  ok  POST /api/admin/cohorts -> ${COH_ID} (code ${JOIN_CODE})"

assert_status 400 "POST /api/admin/cohorts requires scenarioId" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{}' "${BASE}/api/admin/cohorts"

echo "==> Participant: join cohort"
assert_status 400 "POST /api/cohorts/join requires code" \
  -X POST -H 'Content-Type: application/json' \
  -b "${COOKIE_JAR}" \
  -d '{}' "${BASE}/api/cohorts/join"

assert_status 400 "POST /api/cohorts/join rejects bogus code" \
  -X POST -H 'Content-Type: application/json' \
  -b "${COOKIE_JAR}" \
  -d '{"code":"NOPE-NOPE"}' "${BASE}/api/cohorts/join"

JOIN=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -b "${COOKIE_JAR}" \
  -d "{\"code\":\"${JOIN_CODE}\"}" "${BASE}/api/cohorts/join")
node -e "const j=JSON.parse(process.argv[1]); if(j.cohort.id!==process.argv[2]) process.exit(1); if(!j.isNewRun) process.exit(2)" "${JOIN}" "${COH_ID}"
echo "  ok  POST /api/cohorts/join (new run)"

echo "==> Participant: cohort channels visible"
CHANS=$(me "${BASE}/api/channels")
for n in general instructions announcements scoreboard; do
  node -e "const j=JSON.parse(process.argv[1]); if(!j.channels.some(c=>c.displayName===process.argv[2])) process.exit(1)" "${CHANS}" "$n" \
    && echo "  ok  cohort channel #$n present" \
    || (echo "!! missing channel $n in: ${CHANS}" && exit 1)
done
node -e "const j=JSON.parse(process.argv[1]); const dms=j.channels.filter(c=>c.isDm); if(!dms.length) process.exit(1)" "${CHANS}"
echo "  ok  persona DM(s) present"

echo "==> Participant: instructions seeded"
INSTR_ID=$(node -e "console.log(JSON.parse(process.argv[1]).channels.find(c=>c.displayName==='instructions').id)" "${CHANS}")
INSTR_MSGS=$(me "${BASE}/api/channels/${INSTR_ID}/messages?limit=10")
node -e "const j=JSON.parse(process.argv[1]); if(!j.messages.some(m=>/Welcome to SOC Triage/.test(m.body))) process.exit(1)" "${INSTR_MSGS}"
echo "  ok  #instructions seeded with scenario welcome"

echo "==> Participant: starting task fired in DM"
DM_ID=$(node -e "console.log(JSON.parse(process.argv[1]).channels.find(c=>c.isDm).id)" "${CHANS}")
DM_MSGS=$(me "${BASE}/api/channels/${DM_ID}/messages?limit=10")
node -e "const j=JSON.parse(process.argv[1]); if(!j.messages.some(m=>/ATT.CK technique/.test(m.body))) process.exit(1)" "${DM_MSGS}"
echo "  ok  task prompt posted in persona DM"

echo "==> Scoreboard: empty cohort starts at zero"
SB=$(me "${BASE}/api/scoreboard/${COH_ID}")
node -e "const j=JSON.parse(process.argv[1]); if(j.runs.length!==1) process.exit(1); if(j.runs[0].score!==0) process.exit(2)" "${SB}"
echo "  ok  GET /api/scoreboard/:id shows alex with score 0"
node -e "const j=JSON.parse(process.argv[1]); if(j.tasksTotal!==1) process.exit(1); if(j.runs[0].tasksCompleted!==0||j.runs[0].tasksTotal!==1) process.exit(2)" "${SB}"
echo "  ok  scoreboard reports tasksTotal=1 and tasksCompleted=0"

echo "==> Read-only enforcement"
INSTR_DATA="{\"channelId\":\"${INSTR_ID}\",\"body\":\"hi\"}"
# Posting from a participant via REST isn't part of the API surface; we skip
# socket-based send and instead verify the policy column is exposed.
node -e "const j=JSON.parse(process.argv[1]); const ch=j.channels.find(c=>c.displayName==='instructions'); if(ch.postingPolicy!=='engine') process.exit(1)" "${CHANS}"
echo "  ok  #instructions posting_policy=engine"

echo "==> Task grading via Socket.io"
DM_NAME=$(node -e "console.log(JSON.parse(process.argv[1]).channels.find(c=>c.isDm).name)" "${CHANS}")
GRADE_OUT=$(node scripts/socket-task-test.js "${BASE}" "${COOKIE_JAR}" "${DM_ID}" "T1566.001" 2>&1)
echo "${GRADE_OUT}" | grep -q "graded:correct" \
  && echo "  ok  correct answer scored via socket" \
  || (echo "!! grading test failed: ${GRADE_OUT}" && exit 1)

# Confirm score moved
SB=$(me "${BASE}/api/scoreboard/${COH_ID}")
node -e "const j=JSON.parse(process.argv[1]); const r=j.runs[0]; if(r.score!==125) process.exit(1); if(r.tasksCompleted!==1) process.exit(2)" "${SB}"
echo "  ok  scoreboard shows score=125 (100 + 25 first-blood) and tasksCompleted=1/1"

echo "==> Admin: announce broadcast"
adminJSON -X POST \
  -d "{\"body\":\"5 minute warning\"}" \
  "${BASE}/api/admin/cohorts/${COH_ID}/announce" >/dev/null
ANN_ID=$(node -e "console.log(JSON.parse(process.argv[1]).channels.find(c=>c.displayName==='announcements').id)" "${CHANS}")
ANN_MSGS=$(me "${BASE}/api/channels/${ANN_ID}/messages?limit=10")
node -e "const j=JSON.parse(process.argv[1]); if(!j.messages.some(m=>m.body==='5 minute warning')) process.exit(1)" "${ANN_MSGS}"
echo "  ok  proctor announcement appeared in #announcements"

echo "==> GitHub sync input validation"
assert_status 400 "POST /api/admin/github/sync with no repo" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{}' "${BASE}/api/admin/github/sync"
assert_status 400 "POST /api/admin/github/sync with no token" \
  -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" \
  -d '{"repo":"acme/scenarios"}' "${BASE}/api/admin/github/sync"

# ---- Single-event mode in a *second* server instance (different port + data dir).
echo "==> Single-event mode: registration + auto sign-in"
EVENT_PORT=$((PORT + 100))
EVENT_DATA="$(mktemp -d)"
EVENT_INVITE="INVITE-XYZ789"

# Boot the event server first to create the scenario, then restart it bound
# to that scenario via EVENT_SCENARIO_ID. (We do it in two phases because the
# scenario id is generated by the server.)
PORT="${EVENT_PORT}" ADMIN_TOKEN="${ADMIN_TOKEN}" DATA_DIR="${EVENT_DATA}" \
  node server.js >/tmp/event-server.log 2>&1 &
EVENT_PID=$!
for i in {1..40}; do
  if curl -fsS "http://127.0.0.1:${EVENT_PORT}/api/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "${EVENT_PID}" 2>/dev/null; then
    echo "!! event server exited. Log:"; cat /tmp/event-server.log; exit 1
  fi
  sleep 0.25
done

EVENT_SC_PAYLOAD="$(mktemp)"
node -e '
  process.stdout.write(JSON.stringify({
    name: "event-smoke",
    description: "auto-bound to event cohort",
    definition: { personas: [], tasks: [] },
  }));
' > "${EVENT_SC_PAYLOAD}"
EVENT_SC_ID=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -H "x-admin-token: ${ADMIN_TOKEN}" --data-binary "@${EVENT_SC_PAYLOAD}" \
  "http://127.0.0.1:${EVENT_PORT}/api/admin/scenarios" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{console.log(JSON.parse(d).id)})")
rm -f "${EVENT_SC_PAYLOAD}"
kill ${EVENT_PID} 2>/dev/null || true
wait ${EVENT_PID} 2>/dev/null || true

# Restart with auto-signin bound to the scenario.
PORT="${EVENT_PORT}" ADMIN_TOKEN="${ADMIN_TOKEN}" DATA_DIR="${EVENT_DATA}" \
  AUTO_SIGNIN_MODE=true \
  EVENT_INVITE_ID="${EVENT_INVITE}" \
  EVENT_SCENARIO_ID="${EVENT_SC_ID}" \
  EVENT_COHORT_NAME="Smoke event" \
  EVENT_ADMIN_MODE=true \
  node server.js >>/tmp/event-server.log 2>&1 &
EVENT_PID=$!
for i in {1..40}; do
  if curl -fsS "http://127.0.0.1:${EVENT_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.25
done

# /api/event reports the bound cohort.
EVT=$(curl -fsS "http://127.0.0.1:${EVENT_PORT}/api/event")
node -e "const j=JSON.parse(process.argv[1]); if(!j.autoSigninMode) process.exit(1); if(!j.cohort||j.cohort.name!==process.argv[2]) process.exit(2); if(!j.adminCohortAvailable) process.exit(3)" "${EVT}" "Smoke event"
echo "  ok  GET /api/event reports bound cohort + admin cohort"

# /register page is served.
assert_status 200 "GET /register" "http://127.0.0.1:${EVENT_PORT}/register"

# / without a session redirects to /register.
LANDING=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${EVENT_PORT}/")
[[ "${LANDING}" == "302" || "${LANDING}" == "303" ]] \
  && echo "  ok  / without session redirects (${LANDING})" \
  || (echo "!! / expected redirect, got ${LANDING}" && exit 1)

# POST /api/register creates the user + joins the cohort.
EVENT_JAR="$(mktemp)"
REG=$(curl -fsS -X POST -H 'Content-Type: application/json' \
  -c "${EVENT_JAR}" \
  -d '{"email":"sam@acme.example","displayName":"Sam Tester"}' \
  "http://127.0.0.1:${EVENT_PORT}/api/register")
node -e "const j=JSON.parse(process.argv[1]); if(!j.ok) process.exit(1); if(j.redirectTo!=='/') process.exit(2)" "${REG}"
echo "  ok  POST /api/register accepts email + displayName"

# The participant should now be in the event cohort.
ME=$(curl -fsS -b "${EVENT_JAR}" "http://127.0.0.1:${EVENT_PORT}/api/me")
node -e "const j=JSON.parse(process.argv[1]); if(!j.cohort||j.cohort.name!=='Smoke event') process.exit(1); if(j.user.username!=='sam') process.exit(2)" "${ME}"
echo "  ok  /api/me shows user joined Smoke event cohort"

# Direct sign-in URL still works for the external Okta-driven flow.
EVENT_JAR2="$(mktemp)"
LANDING=$(curl -s -o /dev/null -w "%{http_code}" -c "${EVENT_JAR2}" \
  "http://127.0.0.1:${EVENT_PORT}/?u=jordan&n=Jordan")
[[ "${LANDING}" == "302" || "${LANDING}" == "303" ]] \
  && echo "  ok  /?u=...&n=... auto sign-in still works (${LANDING})" \
  || (echo "!! direct sign-in expected redirect, got ${LANDING}" && exit 1)

# Email validation.
assert_status 400 "POST /api/register with invalid email" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email","displayName":"x"}' \
  "http://127.0.0.1:${EVENT_PORT}/api/register"

kill ${EVENT_PID} 2>/dev/null || true
wait ${EVENT_PID} 2>/dev/null || true
rm -rf "${EVENT_DATA}" "${EVENT_JAR}" "${EVENT_JAR2}"

echo "==> All smoke tests passed"
