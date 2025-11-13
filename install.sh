#!/usr/bin/env bash

set -e

# Color output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

echo_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

# Get the directory where this script is located
DOTFILES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo_info "Dotfiles directory: $DOTFILES_DIR"

# Install Homebrew if not installed
if ! command -v brew &> /dev/null; then
    echo_info "Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo_info "Homebrew already installed"
fi

# Install required packages
echo_info "Installing packages via Homebrew..."
brew install neovim zsh fzf zoxide starship

# Create .zsh directory for plugins
ZSH_DIR="$HOME/.zsh"
mkdir -p "$ZSH_DIR"

# Install zsh-autosuggestions
if [ ! -d "$ZSH_DIR/zsh-autosuggestions" ]; then
    echo_info "Installing zsh-autosuggestions..."
    git clone https://github.com/zsh-users/zsh-autosuggestions "$ZSH_DIR/zsh-autosuggestions"
else
    echo_info "zsh-autosuggestions already installed, updating..."
    cd "$ZSH_DIR/zsh-autosuggestions" && git pull && cd -
fi

# Install zsh-syntax-highlighting
if [ ! -d "$ZSH_DIR/zsh-syntax-highlighting" ]; then
    echo_info "Installing zsh-syntax-highlighting..."
    git clone https://github.com/zsh-users/zsh-syntax-highlighting "$ZSH_DIR/zsh-syntax-highlighting"
else
    echo_info "zsh-syntax-highlighting already installed, updating..."
    cd "$ZSH_DIR/zsh-syntax-highlighting" && git pull && cd -
fi

# Backup existing .zshrc if it exists and is not a symlink
if [ -f "$HOME/.zshrc" ] && [ ! -L "$HOME/.zshrc" ]; then
    echo_warning "Backing up existing .zshrc to .zshrc.backup"
    mv "$HOME/.zshrc" "$HOME/.zshrc.backup"
fi

# Symlink .zshrc
echo_info "Creating symlink for .zshrc..."
ln -sf "$DOTFILES_DIR/.zshrc" "$HOME/.zshrc"

# Backup existing nvim config if it exists and is not a symlink
if [ -d "$HOME/.config/nvim" ] && [ ! -L "$HOME/.config/nvim" ]; then
    echo_warning "Backing up existing nvim config to .config/nvim.backup"
    mv "$HOME/.config/nvim" "$HOME/.config/nvim.backup"
fi

# Create .config directory if it doesn't exist
mkdir -p "$HOME/.config"

# Symlink nvim config
echo_info "Creating symlink for nvim config..."
ln -sf "$DOTFILES_DIR/nvim" "$HOME/.config/nvim"

# Install nvim plugins using lazy.nvim
echo_info "Installing nvim plugins..."
nvim --headless "+Lazy! sync" +qa

echo ""
echo_info "Installation complete!"
echo_info "Please restart your terminal or run: source ~/.zshrc"
echo ""
echo_info "If you want to set zsh as your default shell, run:"
echo "  chsh -s $(which zsh)"
