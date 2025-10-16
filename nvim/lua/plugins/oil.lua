return {
	"stevearc/oil.nvim",
	lazy = false, -- Load immediately to handle directory opening
	opts = {
		default_file_explorer = true,
	},
	dependencies = { "nvim-tree/nvim-web-devicons" },
	init = function()
		-- Disable netrw (Vim's built-in file explorer)
		vim.g.loaded_netrw = 1
		vim.g.loaded_netrwPlugin = 1
	end,
}
