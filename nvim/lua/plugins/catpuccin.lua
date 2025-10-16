return {
	"catppuccin/nvim",
	name = "catppuccin",
	priority = 1000,
	opts = {
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
			noice = true,
			which_key = true,
		},
	},
}