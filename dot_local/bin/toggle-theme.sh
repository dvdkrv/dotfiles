#!/usr/bin/env bash
# Toggle tmux between Catppuccin Mocha (dark) and Latte (light)

STATE="${XDG_STATE_HOME:-$HOME/.local/state}/theme"
mkdir -p "$(dirname "$STATE")"

current=$(cat "$STATE" 2>/dev/null || echo "dark")
next=$([[ "$current" == "dark" ]] && echo "light" || echo "dark")
echo "$next" > "$STATE"

if [[ "$next" == "dark" ]]; then
  tmux set -g status-style 'bg=#1e1e2e,fg=#cdd6f4'
  tmux set -g status-left '#[bg=#a6e3a1,fg=#1e1e2e,bold] #S #[bg=#1e1e2e] '
  tmux set -g status-right '#[fg=#89b4fa]%H:%M #[fg=#cdd6f4]| #[fg=#f9e2af]%Y-%m-%d '
  tmux set -g window-status-format '#[fg=#7f849c] #I:#W '
  tmux set -g window-status-current-format '#[bg=#313244,fg=#a6e3a1,bold] #I:#W '
  tmux set -g pane-border-style 'fg=#1e1e2e'
  tmux set -g pane-active-border-style 'fg=#a6e3a1'
else
  tmux set -g status-style 'bg=#eff1f5,fg=#4c4f69'
  tmux set -g status-left '#[bg=#40a02b,fg=#eff1f5,bold] #S #[bg=#eff1f5] '
  tmux set -g status-right '#[fg=#1e66f5]%H:%M #[fg=#4c4f69]| #[fg=#df8e1d]%Y-%m-%d '
  tmux set -g window-status-format '#[fg=#acb0be] #I:#W '
  tmux set -g window-status-current-format '#[bg=#ccd0da,fg=#40a02b,bold] #I:#W '
  tmux set -g pane-border-style 'fg=#eff1f5'
  tmux set -g pane-active-border-style 'fg=#40a02b'
fi

tmux display-message "Theme: $next"
