#!/usr/bin/env bash
# Sync tmux theme from LC_TERMINAL_THEME forwarded by the SSH client.
# Called from tmux client-attached hook.
#
# Requires ~/.ssh/config on the connecting machine to include:
#   SendEnv LC_TERMINAL_THEME
# (Most Ubuntu/Debian sshd configs already AcceptEnv LANG LC_*)

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/theme"
current=$(cat "$STATE" 2>/dev/null || echo "dark")

# LC_TERMINAL_THEME is imported into the tmux environment via update-environment
env_theme=$(tmux show-environment LC_TERMINAL_THEME 2>/dev/null | sed 's/^LC_TERMINAL_THEME=//')

[[ "$env_theme" == "dark" || "$env_theme" == "light" ]] || exit 0
[[ "$env_theme" == "$current" ]] && exit 0

~/.local/bin/toggle-theme.sh "$env_theme"
