################# User configuration #################

export SHELL="/usr/bin/zsh"

# Preferred editor for local and remote sessions
if [[ -n $SSH_CONNECTION ]]; then
  export EDITOR='vim'
else
  export EDITOR='nvim'
fi

# zoxide
eval "$(zoxide init zsh)"
alias cd=z

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
source ~/.zsh/fzf-tab.plugin.zsh
