return {
	"williamboman/mason.nvim",
	cmd = "Mason",
	lazy = false,
	priority = 900,
	opts = {
		ui = {
			border = "rounded",
			icons = {
				package_installed = "✓",
				package_pending = "➜",
				package_uninstalled = "✗",
			},
		},
	},
}
