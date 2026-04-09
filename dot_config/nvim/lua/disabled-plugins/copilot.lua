return {
	"github/copilot.vim",
	event = "InsertEnter",
	config = function()
		vim.g.copilot_no_tab_map = true
		vim.g.copilot_assume_mapped = true
		vim.keymap.set("i", "<C-J>", 'copilot#Accept("<CR>")', {
			expr = true,
			silent = true,
			replace_keycodes = false,
			desc = "Accept Copilot suggestion",
		})
	end,
}
