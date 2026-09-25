#!/usr/bin/env bash
# Pinned tmux session persistence plugins, loaded directly by ~/.tmux.conf.
# Update revisions deliberately.
set -euo pipefail

command -v git >/dev/null 2>&1 || { echo "git is required to install tmux plugins" >&2; exit 1; }

PLUGIN_DIR="$HOME/.tmux/plugins"
mkdir -p "$PLUGIN_DIR"

reconcile_plugin() {
  local url="$1"
  local revision="$2"
  local name
  name="$(basename "$url" .git)"
  local destination="$PLUGIN_DIR/$name"

  if [[ -e "$destination" && ! -d "$destination/.git" ]]; then
    echo "$destination exists but is not a git checkout" >&2
    return 1
  fi
  if [[ ! -d "$destination/.git" ]]; then
    git clone --filter=blob:none "$url" "$destination"
  fi
  git -C "$destination" fetch --quiet origin "$revision"
  git -C "$destination" checkout --quiet --detach "$revision"
}

reconcile_plugin https://github.com/tmux-plugins/tmux-resurrect.git cff343cf9e81983d3da0c8562b01616f12e8d548
reconcile_plugin https://github.com/tmux-plugins/tmux-continuum.git 0698e8f4b17d6454c71bf5212895ec055c578da0
