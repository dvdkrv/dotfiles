return {
	"catppuccin/nvim",
	name = "catppuccin",
	priority = 1000,
	opts = {
		flavour = "auto", -- "auto" respects vim.opt.background (dark = mocha, light = latte)
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