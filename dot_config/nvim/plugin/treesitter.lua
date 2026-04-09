vim.pack.add({
  'https://github.com/nvim-treesitter/nvim-treesitter',
  'https://github.com/nvim-treesitter/nvim-treesitter-textobjects',
  'https://github.com/nvim-treesitter/nvim-treesitter-context',
})

-- Install common parsers eagerly and auto-install on new filetypes.
-- The new nvim-treesitter API uses :TSInstall instead of ensure_installed.
local parsers = {
  "c", "cpp", "go", "python", "rust", "lua", "vim", "vimdoc", "query",
  "markdown", "markdown_inline", "javascript", "typescript", "tsx",
  "json", "yaml", "toml", "html", "css", "bash",
}

vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = function()
  require('nvim-treesitter.install').install(parsers, { summary = false })
end })

-- Auto-install parser for any filetype not in the list above.
-- Only attempt install if the language is a known nvim-treesitter parser.
vim.api.nvim_create_autocmd('FileType', { callback = function(ev)
  local lang = vim.treesitter.language.get_lang(ev.match) or ev.match
  if require('nvim-treesitter.parsers')[lang] then
    pcall(require('nvim-treesitter.install').install, { lang }, { summary = false })
  end
end })

-- Treesitter-context
require("treesitter-context").setup({ max_lines = 3 })

vim.keymap.set("n", "<leader>[", function()
  require("treesitter-context").go_to_context(vim.v.count1)
end, { silent = true, desc = "Go to context" })

-- Textobjects — new API uses explicit keymaps calling module functions directly
require("nvim-treesitter-textobjects").setup({
  select = { lookahead = true },
  move = { set_jumps = true },
})

local sel = require("nvim-treesitter-textobjects.select")
local function so(query) return function() sel.select_textobject(query, "textobjects") end end

vim.keymap.set({ "x", "o" }, "af", so("@function.outer"),   { desc = "Outer function" })
vim.keymap.set({ "x", "o" }, "if", so("@function.inner"),   { desc = "Inner function" })
vim.keymap.set({ "x", "o" }, "ac", so("@class.outer"),      { desc = "Outer class" })
vim.keymap.set({ "x", "o" }, "ic", so("@class.inner"),      { desc = "Inner class" })
vim.keymap.set({ "x", "o" }, "aa", so("@parameter.outer"),  { desc = "Outer parameter" })
vim.keymap.set({ "x", "o" }, "ia", so("@parameter.inner"),  { desc = "Inner parameter" })

local mov = require("nvim-treesitter-textobjects.move")
local function ns(query) return function() mov.goto_next_start(query,     "textobjects") end end
local function ne(query) return function() mov.goto_next_end(query,       "textobjects") end end
local function ps(query) return function() mov.goto_previous_start(query, "textobjects") end end
local function pe(query) return function() mov.goto_previous_end(query,   "textobjects") end end

vim.keymap.set({ "n", "x", "o" }, "]f", ns("@function.outer"), { desc = "Next function start" })
vim.keymap.set({ "n", "x", "o" }, "]c", ns("@class.outer"),    { desc = "Next class start" })
vim.keymap.set({ "n", "x", "o" }, "]F", ne("@function.outer"), { desc = "Next function end" })
vim.keymap.set({ "n", "x", "o" }, "]C", ne("@class.outer"),    { desc = "Next class end" })
vim.keymap.set({ "n", "x", "o" }, "[f", ps("@function.outer"), { desc = "Prev function start" })
vim.keymap.set({ "n", "x", "o" }, "[c", ps("@class.outer"),    { desc = "Prev class start" })
vim.keymap.set({ "n", "x", "o" }, "[F", pe("@function.outer"), { desc = "Prev function end" })
vim.keymap.set({ "n", "x", "o" }, "[C", pe("@class.outer"),    { desc = "Prev class end" })
