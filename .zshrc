################# User configuration #################

export SHELL="/usr/bin/zsh"

# Stable SSH agent socket (fixes stale SSH_AUTH_SOCK in long-running processes like Claude Code)
if [[ -n "$SSH_AUTH_SOCK" && "$SSH_AUTH_SOCK" != "$HOME/.ssh/ssh_auth_sock" ]]; then
    ln -sf "$SSH_AUTH_SOCK" "$HOME/.ssh/ssh_auth_sock" 2>/dev/null
fi
export SSH_AUTH_SOCK="$HOME/.ssh/ssh_auth_sock"

# Preferred editor for local and remote sessions
if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vim'
else
  export EDITOR='nvim'
fi

# fzf
source <(fzf --zsh)

# Starship
eval "$(starship init zsh)"

# Autosuggestions
source ~/.zsh/zsh-autosuggestions/zsh-autosuggestions.zsh

# Syntax highlighting
source ~/.zsh/zsh-syntax-highlighting/zsh-syntax-highlighting.zsh

# fzf-tab
autoload -U compinit; compinit
source ~/.zsh/fzf-tab/fzf-tab.plugin.zsh

# zoxide (must be last)
export _ZO_DOCTOR=0
eval "$(zoxide init zsh)"
alias cd=z
