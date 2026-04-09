vim.pack.add({
  'https://github.com/nvim-tree/nvim-web-devicons',
  'https://github.com/nvimdev/lspsaga.nvim',
})

require("lspsaga").setup({
  lightbulb = { enable = false },
  symbol_in_winbar = { enable = false },
})
