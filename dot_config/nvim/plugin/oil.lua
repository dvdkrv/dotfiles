vim.pack.add({
  'https://github.com/nvim-tree/nvim-web-devicons',
  'https://github.com/stevearc/oil.nvim',
})

require("oil").setup({
  default_file_explorer = true,
  float = { border = "rounded" },
  preview = { border = "rounded" },
  progress = { border = "rounded" },
  keymaps_help = { border = "rounded" },
})

vim.keymap.set("n", "<leader>-", "<cmd>Oil<cr>", { desc = "Open Oil" })
