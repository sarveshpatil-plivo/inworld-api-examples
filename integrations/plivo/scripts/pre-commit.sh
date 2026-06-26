#!/usr/bin/env bash
# pre-commit gate for the Plivo + Inworld examples (HARNESS.md layer L2).
# Install:  integrations/plivo/scripts/install-hooks.sh
# Bypass (rarely):  git commit --no-verify

set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"
STAGED=$(git diff --cached --name-only --diff-filter=ACM)
[[ -z "$STAGED" ]] && exit 0
FAIL=0

# 1. Never commit a real .env
if echo "$STAGED" | grep -qE '(^|/)\.env$'; then
  echo "✗ pre-commit: a .env file is staged — never commit secrets."; FAIL=1
fi

# 1b. A staged .env.example must ship blank secret keys — catches the real
#     near-miss the quoted-secret scan below misses (dotenv is unquoted KEY=value).
for f in $(echo "$STAGED" | grep -E '(^|/)\.env\.example$' || true); do
  added=$(git diff --cached -U0 -- "$f" | grep '^+' | grep -v '^+++')
  if echo "$added" | grep -Eq '^\+(INWORLD_API_KEY|DEEPGRAM_API_KEY|ELEVENLABS_API_KEY|GEMINI_API_KEY|PLIVO_AUTH_ID|PLIVO_AUTH_TOKEN)=.+'; then
    echo "✗ pre-commit: $f has a filled-in secret value — .env.example must ship blank."; FAIL=1
  fi
done

# 2. Fast scan of staged source/doc content (added lines only)
STAGED_SRC=$(echo "$STAGED" | grep -E '\.(ts|md)$' | grep -v node_modules || true)
for f in $STAGED_SRC; do
  added=$(git diff --cached -U0 -- "$f" | grep '^+' | grep -v '^+++')
  if echo "$added" | grep -Eq 'sk-[A-Za-z0-9]{20,}|xi-api-key[^=]*[A-Za-z0-9]{20,}|(API_KEY|AUTH_TOKEN) *= *["'"'"'][A-Za-z0-9]{16,}'; then
    echo "✗ pre-commit: possible hardcoded secret in $f"; FAIL=1
  fi
  if echo "$added" | grep -Eq 'not yet verified|Realtime-only|never run live|TODO|FIXME|XXX'; then
    echo "✗ pre-commit: internal-status / TODO marker in $f"; FAIL=1
  fi
  if echo "$added" | grep -Eq 'python-agents-examples|constitution'; then
    echo "✗ pre-commit: private-repo reference in $f"; FAIL=1
  fi
done

# 3. Run the full validator on each Plivo example that has staged changes
EXAMPLES=$(echo "$STAGED" | sed -nE 's#^integrations/plivo/([^/]+)/.*#\1#p' | grep -v '^scripts$' | sort -u)
for ex in $EXAMPLES; do
  if [[ -f "$ROOT/integrations/plivo/$ex/inbound/agent.ts" ]]; then
    echo "→ validating integrations/plivo/$ex"
    "$ROOT/integrations/plivo/scripts/validate-example.sh" "$ex" >/tmp/_validate.$$  2>&1 || { grep '\[FAIL\]' /tmp/_validate.$$; FAIL=1; }
    rm -f /tmp/_validate.$$
  fi
done

if [[ $FAIL -ne 0 ]]; then
  echo "✗ pre-commit gate failed — fix the above or 'git commit --no-verify' to bypass."
  exit 1
fi
echo "✓ pre-commit gate passed"
exit 0
