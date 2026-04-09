vim.pack.add({
  'https://github.com/MunifTanjim/nui.nvim',
  'https://github.com/rcarriga/nvim-notify',
  'https://github.com/folke/noice.nvim',
})

require("noice").setup({
  lsp = {
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

vim.api.nvim_set_hl(0, "NoiceCmdlinePopup", { bg = "NONE" })
vim.api.nvim_set_hl(0, "NoiceCmdlinePopupBorder", { bg = "NONE" })
vim.api.nvim_set_hl(0, "NoiceCmdlineIcon", { bg = "NONE" })
vim.api.nvim_set_hl(0, "NoiceConfirm", { bg = "NONE" })
vim.api.nvim_set_hl(0, "NoiceConfirmBorder", { bg = "NONE" })
