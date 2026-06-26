#!/usr/bin/env bash
# Install the Plivo examples pre-commit gate into this clone's .git/hooks.
# Run once per clone:  integrations/plivo/scripts/install-hooks.sh
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
HOOK="$ROOT/.git/hooks/pre-commit"
SRC="$ROOT/integrations/plivo/scripts/pre-commit.sh"
chmod +x "$SRC" "$ROOT/integrations/plivo/scripts/validate-example.sh"
cat > "$HOOK" <<EOF
#!/usr/bin/env bash
exec "$SRC"
EOF
chmod +x "$HOOK"
echo "✓ installed pre-commit hook → $HOOK"
