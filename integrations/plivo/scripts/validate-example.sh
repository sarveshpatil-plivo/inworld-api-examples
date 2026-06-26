#!/usr/bin/env bash
# validate-example.sh — deterministic checks for a Plivo + Inworld voice-agent example.
#
# Usage:  integrations/plivo/scripts/validate-example.sh <example-folder>
#         (e.g. s2s-pipeline, stt-llm-tts-pipeline)
# Exit:   0 = all checks pass, 1 = one or more failed.
#
# Catches the classes of bug that LLM review can't: missing playAudio fields,
# secret/internal-status leaks, broken structure. See HARNESS.md (layer L2).

set -uo pipefail

if [[ $# -lt 1 ]]; then echo "usage: $0 <example-folder>"; exit 2; fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIVO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"        # integrations/plivo
EX="$1"
DIR="$PLIVO_DIR/$EX"
AGENT="$DIR/inbound/agent.ts"
SERVER="$DIR/inbound/server.ts"

if [[ ! -d "$DIR" ]]; then echo "ERROR: no such example: $DIR"; exit 2; fi

PASS=0; FAIL=0; SKIP=0
pass(){ echo "  [PASS] $1"; PASS=$((PASS+1)); }
fail(){ echo "  [FAIL] $1"; FAIL=$((FAIL+1)); }
skip(){ echo "  [SKIP] $1"; SKIP=$((SKIP+1)); }
# has <file> <regex> <label>
has(){ if grep -Eq "$2" "$1" 2>/dev/null; then pass "$3"; else fail "$3"; fi; }

echo "=========================================="
echo "Validating: integrations/plivo/$EX"
echo "=========================================="

echo "--- Structure ---"
for f in inbound/agent.ts inbound/server.ts inbound/system_prompt.md utils.ts \
         package.json tsconfig.json .env.example README.md CLAUDE.md AGENTS.md; do
  [[ -f "$DIR/$f" ]] && pass "exists: $f" || fail "missing: $f"
done

echo "--- Audio pipeline (agent.ts) ---"
has "$AGENT" 'contentType.*audio/x-mulaw'        "playAudio sets contentType audio/x-mulaw"
has "$AGENT" 'sampleRate.*8000'                  "playAudio sets sampleRate 8000"
has "$AGENT" 'PLIVO_CHUNK_SIZE *= *160'          "160-byte (20ms) chunk size"

echo "--- Barge-in plumbing (agent.ts) ---"
has "$AGENT" 'clearAudio'                        "sends clearAudio on barge-in"
has "$AGENT" 'response\.cancel|activeAbort|\.abort\(\)' "cancels in-flight response on barge-in"
has "$AGENT" 'isSpeaking|agentSpeaking'          "barge-in gated on a speaking state"

echo "--- Telephony / provisioning (server.ts) ---"
has "$SERVER" 'configurePlivoWebhooks'           "auto-provisions Plivo on startup"
has "$SERVER" '/answer'                          "has /answer webhook"
has "$SERVER" '/hangup'                          "handles /hangup call event"
has "$SERVER" 'audio/x-mulaw;rate=8000'          "Stream XML uses μ-law 8k"

echo "--- README (docs structure) ---"
for s in "## Prerequisites" "## Setup" "## How it works"; do
  grep -Fq "$s" "$DIR/README.md" 2>/dev/null && pass "README has '$s'" || fail "README missing '$s'"
done

echo "--- Hygiene (no secrets / internal status / private refs in tracked files) ---"
# tracked, non-.env files only
# authored source/docs only — exclude generated lock files & deps
FILES=$(find "$DIR" -type f \( -name '*.ts' -o -name '*.md' \) ! -path '*/node_modules/*' ! -path '*/dist/*' 2>/dev/null)
scan(){ # <regex> <label>
  local hit; hit=$(grep -REl "$1" $FILES 2>/dev/null | sed "s#$PLIVO_DIR/##")
  if [[ -n "$hit" ]]; then fail "$2 — in: $(echo "$hit" | tr '\n' ' ')"; else pass "$2"; fi
}
scan 'sk-[A-Za-z0-9]{20,}|xi-api-key[^=]*[A-Za-z0-9]{20,}|(API_KEY|AUTH_TOKEN) *= *["'"'"'][A-Za-z0-9]{16,}' "no hardcoded secrets"
scan 'not yet verified|Realtime-only|never run live|TODO|FIXME|XXX' "no internal-status / TODO markers"
scan 'python-agents-examples|constitution' "no private-repo references"

# .env.example must ship as a blank template — a filled-in secret here is the
# one leak the code-style scan above misses (dotenv uses unquoted KEY=value).
ENVEX="$DIR/.env.example"
if [[ -f "$ENVEX" ]]; then
  if grep -Eq '^(INWORLD_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY|GEMINI_API_KEY|PLIVO_AUTH_ID|PLIVO_AUTH_TOKEN)=.+' "$ENVEX"; then
    fail ".env.example ships blank secret keys (found a filled-in value)"
  else
    pass ".env.example ships blank secret keys"
  fi
fi

echo "--- Typecheck ---"
if [[ -d "$DIR/node_modules" ]]; then
  if ( cd "$DIR" && npx tsc --noEmit >/dev/null 2>&1 ); then pass "tsc --noEmit clean"; else fail "tsc --noEmit errors"; fi
else
  skip "tsc (node_modules not installed)"
fi

echo "=========================================="
echo "PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
echo "=========================================="
[[ $FAIL -eq 0 ]]
