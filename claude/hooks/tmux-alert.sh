#!/bin/bash
# tmux-alert.sh: Highlight the tmux window tab when Claude needs attention.
#
# Yellow tab  → task done / waiting for your next prompt  (Stop, idle_prompt)
# Red tab     → needs your approval before proceeding     (PermissionRequest, permission_prompt)
# Reset       → user responded or new session started     (UserPromptSubmit, SessionStart)
#
# Colors from Catppuccin Mocha: surface0=#313244, yellow=#f9e2af, red=#f38ba8
#
# NOTE: Claude Code hook subprocesses don't inherit $TMUX/$TMUX_PANE, so we find
# the right window by matching ancestor PIDs against tmux pane PIDs.

set -uo pipefail

# No-op if tmux server isn't running at all
tmux info &>/dev/null || exit 0

INPUT=$(cat)

# Parse event fields from JSON (each on its own line to handle spaces in cwd)
{
  read -r EVENT
  read -r NTYPE
  read -r CWD
} < <(python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d.get('hook_event_name', ''))
print(d.get('notification_type', ''))
print(d.get('cwd', ''))
" <<< "$INPUT" 2>/dev/null) || exit 0

# Find the tmux window hosting this Claude session.
# Walk the process tree upward from $$, matching against pane PIDs reported by tmux.
# Falls back to matching by cwd if process tree walk fails.
find_window_id() {
  python3 - "$CWD" <<'PYEOF'
import os, subprocess, sys

def tmux(*args):
    r = subprocess.run(['tmux'] + list(args), capture_output=True, text=True, timeout=3)
    return r.stdout.strip()

def find_by_process_tree(pane_map):
    pid = os.getpid()
    for _ in range(20):
        if pid in pane_map:
            return pane_map[pid]
        try:
            r = subprocess.run(['ps', '-o', 'ppid=', '-p', str(pid)],
                               capture_output=True, text=True, timeout=2)
            ppid = r.stdout.strip()
            if not ppid or not ppid.isdigit() or int(ppid) <= 1:
                break
            pid = int(ppid)
        except Exception:
            break
    return ''

def find_by_cwd(cwd):
    if not cwd:
        return ''
    lines = tmux('list-panes', '-a', '-F', '#{window_id} #{pane_current_path}').splitlines()
    for line in lines:
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[1] == cwd:
            return parts[0]
    return ''

try:
    lines = tmux('list-panes', '-a', '-F', '#{pane_pid} #{window_id}').splitlines()
    pane_map = {}
    for line in lines:
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit():
            pane_map[int(parts[0])] = parts[1]
except Exception:
    pane_map = {}

cwd = sys.argv[1] if len(sys.argv) > 1 else ''
win_id = find_by_process_tree(pane_map) or find_by_cwd(cwd)
if win_id:
    print(win_id)
    sys.exit(0)
sys.exit(1)
PYEOF
}

WIN_ID=$(find_window_id) || exit 0
[ -z "$WIN_ID" ] && exit 0

set_alert() {
  local fg="$1"
  tmux set-window-option -t "$WIN_ID" window-status-format \
    "#[bg=#313244,fg=${fg},bold] #I:#W " 2>/dev/null || true
  # One-shot hook: clear alert when user visits the window
  tmux set-hook -t "$WIN_ID" -w pane-focus-in \
    "set-window-option -u -t '${WIN_ID}' window-status-format; set-hook -u -w -t '${WIN_ID}' pane-focus-in" \
    2>/dev/null || true
}

reset_alert() {
  tmux set-window-option -u -t "$WIN_ID" window-status-format 2>/dev/null || true
  tmux set-hook -u -w -t "$WIN_ID" pane-focus-in 2>/dev/null || true
}

case "$EVENT" in
  PermissionRequest)
    set_alert "#f38ba8"  # Catppuccin Red — needs approval
    ;;
  Notification)
    case "$NTYPE" in
      permission_prompt) set_alert "#f38ba8" ;;  # Catppuccin Red
      idle_prompt)       set_alert "#f9e2af" ;;  # Catppuccin Yellow
    esac
    ;;
  Stop)
    set_alert "#f9e2af"  # Catppuccin Yellow — waiting for input
    ;;
  UserPromptSubmit|SessionStart)
    reset_alert
    ;;
esac

exit 0
