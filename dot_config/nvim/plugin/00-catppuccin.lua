vim.pack.add({
  'https://github.com/catppuccin/nvim',
  'https://github.com/rebelot/kanagawa.nvim',
})

require("catppuccin").setup({
  flavour = "auto",
  transparent_background = true,
  integrations = {
    cmp = true,
    gitsigns = true,
    telescope = {
      enabled = true,
      style = "nvchad",
    },
    treesitter = true,
    treesitter_context = true,
    native_lsp = {
      enabled = true,
    },
    notify = true,
    noice = true,
    which_key = true,
  },
})

vim.cmd.colorscheme("catppuccin")
