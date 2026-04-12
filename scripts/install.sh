#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL=com.user.voiced

mkdir -p "$HOME/.voiced/logs" "$HOME/.voiced/models" "$HOME/.voiced/voices" "$AGENTS_DIR"

if [[ ! -x "$ROOT/dist/voiced" ]]; then
    echo "building binary..."
    (cd "$ROOT" && bun run build)
fi

src="$ROOT/launchd/${LABEL}.plist"
dst="$AGENTS_DIR/${LABEL}.plist"

cp "$src" "$dst"
launchctl bootout "gui/$UID/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$UID" "$dst"

for prefix in /opt/homebrew/bin /usr/local/bin; do
    if [[ -d "$prefix" && -w "$prefix" ]]; then
        ln -sf "$ROOT/dist/voiced" "$prefix/voiced"
        echo "symlinked $prefix/voiced"
        break
    fi
done

echo ""
echo "status:"
launchctl list | grep -E "voiced" || true
echo ""
echo "verify: curl http://127.0.0.1:2022/health"
