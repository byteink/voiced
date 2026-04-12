#!/usr/bin/env bash
set -euo pipefail

AGENTS_DIR="$HOME/Library/LaunchAgents"
LABEL=com.user.voiced

launchctl bootout "gui/$UID/${LABEL}" 2>/dev/null || true
rm -f "$AGENTS_DIR/${LABEL}.plist"
for prefix in /opt/homebrew/bin /usr/local/bin; do
    if [[ -L "$prefix/voiced" ]]; then
        rm -f "$prefix/voiced"
        echo "removed symlink $prefix/voiced"
    fi
done
echo "removed ${LABEL}"
