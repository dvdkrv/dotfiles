-- Load only for Lua files (replaces neodev.nvim)
vim.api.nvim_create_autocmd('FileType', { pattern = 'lua', once = true, callback = function()
  vim.pack.add({
    'https://github.com/Bilal2453/luvit-meta',
    'https://github.com/folke/lazydev.nvim',
  })
  require("lazydev").setup({
    library = {
      { path = vim.fn.stdpath('data') .. '/site/pack/core/opt/luvit-meta/library', words = { "vim%.uv" } },
    },
  })
end })
