return {
	"ruifm/gitlinker.nvim",
	keys = {
		{ "<leader>gy", mode = { "n", "v" }, desc = "Copy git link" },
	},
	config = function()
		require("gitlinker").setup()
		vim.keymap.set({ "n", "v" }, "<leader>gy", function()
			require("gitlinker").get_buf_range_url("n")
		end, { desc = "Copy git link" })
	end,
}
