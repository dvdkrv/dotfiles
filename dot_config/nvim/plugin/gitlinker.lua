vim.pack.add({
  'https://github.com/nvim-lua/plenary.nvim',
  'https://github.com/ruifm/gitlinker.nvim',
})

require("gitlinker").setup()

vim.keymap.set({ "n", "v" }, "<leader>gy", function()
  require("gitlinker").get_buf_range_url("n")
end, { desc = "Copy git link" })
