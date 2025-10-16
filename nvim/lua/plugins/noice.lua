return {
	"folke/noice.nvim",
	event = "VeryLazy",
	opts = {
		-- add any options here
	},
	config = function()
		require("noice").setup({
			lsp = {
				-- override markdown rendering so that **cmp** and other plugins use **Treesitter**
				override = {
					["vim.lsp.util.convert_input_to_markdown_lines"] = true,
					["vim.lsp.util.stylize_markdown"] = true,
					["cmp.entry.get_documentation"] = true,
				},
			},
			presets = {
				bottom_search = false,
				command_palette = false,
				long_message_to_split = true,
				inc_rename = false,
				lsp_doc_border = true,
			},
		})
		require("notify").setup({
			background_colour = "#000000",
		})
		
		-- Make noice popups transparent
		vim.api.nvim_set_hl(0, "NoiceCmdlinePopup", { bg = "NONE" })
		vim.api.nvim_set_hl(0, "NoiceCmdlinePopupBorder", { bg = "NONE" })
		vim.api.nvim_set_hl(0, "NoiceCmdlineIcon", { bg = "NONE" })
		vim.api.nvim_set_hl(0, "NoiceConfirm", { bg = "NONE" })
		vim.api.nvim_set_hl(0, "NoiceConfirmBorder", { bg = "NONE" })
	end,
	dependencies = {
		-- if you lazy-load any plugin below, make sure to add proper `module="..."` entries
		"MunifTanjim/nui.nvim",
		-- OPTIONAL:
		--   `nvim-notify` is only needed, if you want to use the notification view.
		--   If not available, we use `mini` as the fallback
		"rcarriga/nvim-notify",
	},
}
