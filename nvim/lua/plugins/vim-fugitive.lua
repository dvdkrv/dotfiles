return {
	"tpope/vim-fugitive",
	cmd = { "Git", "G", "Gdiffsplit", "Gread", "Gwrite", "Ggrep", "GMove", "GDelete", "GBrowse", "GRemove", "GRename", "Glgrep", "Gedit" },
	keys = {
		{ "<leader>gs", "<cmd>Git<cr>", desc = "Git status" },
	},
}
