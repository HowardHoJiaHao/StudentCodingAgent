#!/usr/bin/env bash
# Student key management. Works against either deployment (vps/ or railway/).
# Run it from your own machine — it never needs your DeepSeek key.
#
#   ./students.sh check              verify the deployment before going live
#   ./students.sh new ali 5          approve Ali for $5/30d, prints their key
#   ./students.sh list               everyone, with spend so far
#   ./students.sh show ali           one student's usage
#   ./students.sh topup ali 10       raise the budget
#   ./students.sh block ali          stop them without deleting history
#   ./students.sh unblock ali
#   ./students.sh delete ali         gone for good
#   ./students.sh spend              30-day report across everyone
#
# Config comes from admin.env in this directory — see admin.env.example.

set -euo pipefail
cd "$(dirname "$0")"

[[ -f admin.env ]] || { echo "No admin.env here. Copy admin.env.example and fill it in."; exit 1; }
set -a; source ./admin.env; set +a

# PROXY wins if set; otherwise build it from DOMAIN (the docker-compose path).
PROXY="${PROXY:-${DOMAIN:+https://${DOMAIN}}}"
[[ -n ${PROXY:-} ]] || { echo "Set PROXY or DOMAIN in admin.env — I don't know which server to talk to."; exit 1; }
PROXY="${PROXY%/}"
[[ -n ${LITELLM_MASTER_KEY:-} ]] || { echo "LITELLM_MASTER_KEY missing from admin.env"; exit 1; }

AUTH="Authorization: Bearer ${LITELLM_MASTER_KEY}"
JSON="Content-Type: application/json"

# Concurrency is what actually bounds budget overshoot:
#   worst case ≈ PARALLEL × max_tokens × output price
PARALLEL=5
RPM=60
MODEL=deepseek-chat

die() { echo "error: $*" >&2; exit 1; }
have_jq() { command -v jq >/dev/null 2>&1; }

api() {
  local method=$1 path=$2 body=${3:-}
  if [[ -n $body ]]; then
    curl -sS -X "$method" "${PROXY}${path}" -H "$AUTH" -H "$JSON" -d "$body"
  else
    curl -sS -X "$method" "${PROXY}${path}" -H "$AUTH"
  fi
}

fmt() { if have_jq; then jq "$@"; else cat; fi; }

# LiteLLM addresses keys by token, not alias, so look it up first.
key_for_alias() {
  local alias=$1 token
  have_jq || die "jq is required for name lookups (apt install jq / winget install jqlang.jq)"
  token=$(api GET "/key/list?return_full_object=true&size=100" \
    | jq -r --arg a "$alias" '(.keys // .data // [])[] | select(.key_alias==$a) | .token' | head -1)
  [[ -n $token && $token != "null" ]] || die "no student called '$alias' (try: $0 list)"
  echo "$token"
}

pass() { echo "  [ok]   $*"; }
warn() { echo "  [warn] $*"; }
fail() { echo "  [FAIL] $*"; FAILED=1; }

# Portable "is a > b" without requiring bc.
gt() { awk -v a="${1:-0}" -v b="${2:-0}" 'BEGIN { exit !(a > b) }'; }

cmd=${1:-help}
case "$cmd" in

  check)
    # Preflight. Run this before handing a key to a single student.
    FAILED=0
    echo ""
    echo "  Checking ${PROXY}"
    echo ""

    have_jq || die "jq is required for 'check' (apt install jq)"

    # 1. reachable
    if curl -sS -f -m 15 "${PROXY}/health/liveliness" >/dev/null 2>&1; then
      pass "proxy is reachable"
    else
      fail "cannot reach ${PROXY}/health/liveliness — wrong URL, or still deploying"
      echo ""; exit 1
    fi

    # 2. master key accepted
    if api GET "/key/list?size=1" | grep -qi 'invalid.*key\|unauthor\|authentication_error'; then
      fail "master key rejected — LITELLM_MASTER_KEY doesn't match the server"
      echo ""; exit 1
    else
      pass "master key accepted"
    fi

    # 3. model configured
    if curl -sS -m 15 "${PROXY}/v1/models" -H "$AUTH" | grep -q "$MODEL"; then
      pass "$MODEL is configured"
    else
      fail "$MODEL not listed by /v1/models — check config.yaml and DEEPSEEK_API_KEY"
    fi

    # 4. temp key with a small budget
    tmpkey=$(api POST /key/generate "{\"key_alias\":\"_preflight_$$\",\"max_budget\":0.5,\"budget_duration\":\"30d\",\"models\":[\"$MODEL\"],\"max_parallel_requests\":$PARALLEL}" | jq -r '.key // empty')
    [[ -n $tmpkey ]] || { fail "could not create a test key"; echo ""; exit 1; }
    pass "created a temporary test key"
    # shellcheck disable=SC2064
    trap "api POST /key/delete '{\"keys\":[\"$tmpkey\"]}' >/dev/null 2>&1 || true" EXIT

    # 5. a real completion reaches DeepSeek and comes back
    reply=$(curl -sS -m 60 -X POST "${PROXY}/v1/chat/completions" \
      -H "Authorization: Bearer $tmpkey" -H "$JSON" \
      -d "{\"model\":\"$MODEL\",\"max_tokens\":10,\"messages\":[{\"role\":\"user\",\"content\":\"say OK\"}]}")
    if echo "$reply" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
      pass "completion works end to end (your DeepSeek key is valid)"
    else
      fail "completion failed: $(echo "$reply" | head -c 200)"
    fi

    # 6. streaming — the extension depends on this
    chunks=$(curl -sS -N -m 60 -X POST "${PROXY}/v1/chat/completions" \
      -H "Authorization: Bearer $tmpkey" -H "$JSON" \
      -d "{\"model\":\"$MODEL\",\"stream\":true,\"max_tokens\":30,\"messages\":[{\"role\":\"user\",\"content\":\"count to five\"}]}" \
      | grep -c '^data:' || true)
    if [[ ${chunks:-0} -gt 3 ]]; then
      pass "streaming works ($chunks SSE events)"
    else
      fail "streaming looks broken ($chunks events) — check proxy buffering"
    fi

    # 7. tool calling — the whole agent depends on this
    tools='[{"type":"function","function":{"name":"get_time","description":"Get the current time","parameters":{"type":"object","properties":{}}}}]'
    tc=$(curl -sS -m 60 -X POST "${PROXY}/v1/chat/completions" \
      -H "Authorization: Bearer $tmpkey" -H "$JSON" \
      -d "{\"model\":\"$MODEL\",\"max_tokens\":80,\"tools\":$tools,\"messages\":[{\"role\":\"user\",\"content\":\"What time is it? Use the tool.\"}]}")
    if echo "$tc" | jq -e '.choices[0].message.tool_calls[0]' >/dev/null 2>&1; then
      pass "tool calling works"
    else
      warn "model didn't emit a tool call this time — re-run; if it never does, the agent won't work"
    fi

    # 8. spend recorded? This decides whether students can get tokens for free.
    printf "  ...    waiting for spend to settle"
    spend=0
    for _ in 1 2 3 4 5 6; do
      sleep 2; printf "."
      spend=$(api GET "/key/info?key=$tmpkey" | jq -r '(.info.spend // .spend // 0)')
      gt "$spend" 0 && break
    done
    printf "\n"
    if gt "$spend" 0; then
      pass "spend is being recorded (\$$spend on the test key)"
    else
      fail "spend still \$0 after 12s — metering may be broken; students could burn tokens for free"
    fi

    echo ""
    if [[ $FAILED -eq 0 ]]; then
      echo "  All good. Safe to hand out keys."
    else
      echo "  Something failed above — fix it before giving anyone a key."
    fi
    echo ""
    [[ $FAILED -eq 0 ]]
    ;;

  new)
    name=${2:?usage: $0 new <name> <budget-usd>}
    budget=${3:?usage: $0 new <name> <budget-usd>}
    echo "Creating '$name' with a \$${budget} budget over 30 days..."
    resp=$(api POST /key/generate "$(cat <<JSON
{
  "key_alias": "$name",
  "max_budget": $budget,
  "budget_duration": "30d",
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "max_parallel_requests": $PARALLEL,
  "rpm_limit": $RPM,
  "metadata": {"approved_on": "$(date -u +%Y-%m-%d)", "approved_by": "manual"}
}
JSON
)")
    key=$(echo "$resp" | fmt -r '.key // empty')
    [[ -n ${key:-} ]] || { echo "$resp"; die "key generation failed"; }
    cat <<EOF

  ────────────────────────────────────────────────
   Send $name these two lines:

     Endpoint:  ${PROXY}/v1
     Key:       ${key}

   Budget \$${budget}, resets every 30 days.
  ────────────────────────────────────────────────

EOF
    ;;

  list)
    api GET "/key/list?return_full_object=true&size=100" | fmt -r '
      (.keys // .data // [])
      | map(select(.key_alias != null and (.key_alias | startswith("_preflight_") | not)))
      | sort_by(.key_alias)
      | (["STUDENT","SPENT","BUDGET","STATUS"] | @tsv),
        (.[] | [
          .key_alias,
          ((.spend // 0) * 100 | round / 100 | tostring),
          ((.max_budget // 0) | tostring),
          (if .blocked then "blocked" else "active" end)
        ] | @tsv)' | column -t 2>/dev/null || true
    ;;

  show)
    name=${2:?usage: $0 show <name>}
    api GET "/key/info?key=$(key_for_alias "$name")" | fmt '.info // .'
    ;;

  topup)
    name=${2:?usage: $0 topup <name> <new-budget>}
    budget=${3:?usage: $0 topup <name> <new-budget>}
    api POST /key/update "{\"key\":\"$(key_for_alias "$name")\",\"max_budget\":$budget}" >/dev/null
    echo "$name is now capped at \$$budget"
    ;;

  block)
    name=${2:?usage: $0 block <name>}
    api POST /key/block "{\"key\":\"$(key_for_alias "$name")\"}" >/dev/null
    echo "$name blocked"
    ;;

  unblock)
    name=${2:?usage: $0 unblock <name>}
    api POST /key/unblock "{\"key\":\"$(key_for_alias "$name")\"}" >/dev/null
    echo "$name unblocked"
    ;;

  delete)
    name=${2:?usage: $0 delete <name>}
    read -rp "Delete $name permanently? [y/N] " ok
    [[ ${ok,,} == y ]] || exit 0
    api POST /key/delete "{\"keys\":[\"$(key_for_alias "$name")\"]}" >/dev/null
    echo "$name deleted"
    ;;

  spend)
    api GET "/global/spend/report?start_date=$(date -u -d '30 days ago' +%Y-%m-%d 2>/dev/null || date -u -v-30d +%Y-%m-%d)&end_date=$(date -u +%Y-%m-%d)" | fmt .
    ;;

  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    ;;
esac
