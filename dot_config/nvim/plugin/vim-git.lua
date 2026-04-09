vim.pack.add({
  'https://github.com/tpope/vim-fugitive',
  'https://github.com/tpope/vim-rhubarb',
})

-- <leader>gs is also set by telescope.lua (git_status picker).
-- vim-git.lua loads after telescope.lua (v > t), so this mapping wins.
-- Remove this line if you prefer telescope's git_status on <leader>gs.
vim.keymap.set("n", "<leader>gs", "<cmd>Git<cr>", { desc = "Git status (fugitive)" })
