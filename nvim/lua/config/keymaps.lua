-- Better escape
vim.keymap.set("i", "jk", "<Esc>", { desc = "Exit insert mode" })
vim.keymap.set("i", "kj", "<Esc>", { desc = "Exit insert mode" })

-- Save and quit shortcuts
vim.keymap.set("n", "<leader>w", "<cmd>w<cr>", { desc = "Save file" })
vim.keymap.set("n", "<leader>q", "<cmd>q<cr>", { desc = "Quit" })
vim.keymap.set("n", "<leader>Q", "<cmd>qa!<cr>", { desc = "Quit all without saving" })

-- Clear search highlighting
vim.keymap.set("n", "<Esc>", "<cmd>nohlsearch<cr>", { desc = "Clear search highlight" })

-- Better indenting
vim.keymap.set("v", "<", "<gv", { desc = "Indent left" })
vim.keymap.set("v", ">", ">gv", { desc = "Indent right" })

-- Move lines up/down (using J/K instead of j/k to avoid conflict with window nav)
vim.keymap.set("n", "<A-J>", "<cmd>m .+1<cr>==", { desc = "Move line down" })
vim.keymap.set("n", "<A-K>", "<cmd>m .-2<cr>==", { desc = "Move line up" })
vim.keymap.set("v", "<A-J>", ":m '>+1<cr>gv=gv", { desc = "Move selection down" })
vim.keymap.set("v", "<A-K>", ":m '<-2<cr>gv=gv", { desc = "Move selection up" })

-- Copy to clipboard (with system clipboard already set, these are less needed but kept for consistency)
vim.keymap.set("v", "<leader>y", '"+y', { desc = "Yank to clipboard" })
vim.keymap.set("n", "<leader>Y", '"+yg_', { desc = "Yank to clipboard (line end)" })
vim.keymap.set("n", "<leader>y", '"+y', { desc = "Yank to clipboard" })

-- Paste from clipboard
vim.keymap.set("v", "<leader>p", '"+p', { desc = "Paste from clipboard" })
vim.keymap.set("v", "<leader>P", '"+P', { desc = "Paste before from clipboard" })
vim.keymap.set("n", "<leader>p", '"+p', { desc = "Paste from clipboard" })
vim.keymap.set("n", "<leader>P", '"+P', { desc = "Paste before from clipboard" })

-- Delete to black hole register (don't yank)
vim.keymap.set({ "n", "v" }, "<leader>d", '"_d', { desc = "Delete without yanking" })

-- Copy file path to clipboard
vim.keymap.set("n", "<leader>yp", function()
	local path = vim.fn.expand("%:p")
	vim.fn.setreg("+", path)
	vim.notify("Copied to clipboard: " .. path, vim.log.levels.INFO)
end, { desc = "Copy file path to clipboard" })

-- Copy relative file path to clipboard
vim.keymap.set("n", "<leader>yr", function()
	local path = vim.fn.expand("%:.")
	vim.fn.setreg("+", path)
	vim.notify("Copied to clipboard: " .. path, vim.log.levels.INFO)
end, { desc = "Copy relative file path to clipboard" })

vim.keymap.set("n", "<leader>[", function()
	require("treesitter-context").go_to_context(vim.v.count1)
end, { silent = true, desc = "Go to context" })

-- Buffer management
vim.keymap.set("n", "<leader>bd", "<cmd>bd<cr>", { desc = "Delete buffer" })
vim.keymap.set("n", "<leader>bD", "<cmd>bd!<cr>", { desc = "Delete buffer (force)" })
vim.keymap.set("n", "]b", "<cmd>bnext<cr>", { desc = "Next buffer" })
vim.keymap.set("n", "[b", "<cmd>bprevious<cr>", { desc = "Previous buffer" })

-- Window management
vim.keymap.set("n", "<leader>sv", "<cmd>vsplit<cr>", { desc = "Split vertically" })
vim.keymap.set("n", "<leader>sh", "<cmd>split<cr>", { desc = "Split horizontally" })
vim.keymap.set("n", "<leader>se", "<C-w>=", { desc = "Make splits equal size" })
vim.keymap.set("n", "<leader>sx", "<cmd>close<cr>", { desc = "Close current split" })

-- Resize windows
vim.keymap.set("n", "<C-Up>", "<cmd>resize +2<cr>", { desc = "Increase window height" })
vim.keymap.set("n", "<C-Down>", "<cmd>resize -2<cr>", { desc = "Decrease window height" })
vim.keymap.set("n", "<C-Left>", "<cmd>vertical resize -2<cr>", { desc = "Decrease window width" })
vim.keymap.set("n", "<C-Right>", "<cmd>vertical resize +2<cr>", { desc = "Increase window width" })

-- Telescope
local builtin = require("telescope.builtin")
vim.keymap.set("n", "<leader>ff", builtin.find_files, { desc = "Find files" })
vim.keymap.set("n", "<leader>fg", builtin.live_grep, { desc = "Live grep" })
vim.keymap.set("n", "<leader><leader>", builtin.buffers, { desc = "Find buffers" })
vim.keymap.set("n", "<leader>fh", builtin.help_tags, { desc = "Help tags" })
vim.keymap.set("n", "<leader>gc", builtin.git_commits, { desc = "Git commits" })
vim.keymap.set("n", "<leader>gs", builtin.git_status, { desc = "Git status" })
vim.keymap.set("n", "<leader>fo", builtin.oldfiles, { desc = "Recent files" })
vim.keymap.set("n", "<leader>fw", builtin.grep_string, { desc = "Find word under cursor" })

-- Diagnostics
vim.keymap.set("n", "<leader>e", vim.diagnostic.open_float, { desc = "Open diagnostic" })
vim.keymap.set("n", "<leader>dl", vim.diagnostic.setloclist, { desc = "Diagnostics to location list" })

-- LSPSaga keymaps (standardized to vim.keymap.set)
vim.keymap.set("n", "<leader>ca", "<cmd>Lspsaga code_action<cr>", { desc = "Show code actions" })
vim.keymap.set("n", "gd", "<cmd>Lspsaga peek_definition<cr>", { desc = "Peek definition" })
vim.keymap.set("n", "<leader>gd", "<cmd>Lspsaga goto_definition<cr>", { desc = "Go to definition" })
vim.keymap.set("n", "<leader>tt", "<cmd>Lspsaga term_toggle<cr>", { desc = "Toggle terminal" })
vim.keymap.set("n", "[d", "<cmd>Lspsaga diagnostic_jump_prev<cr>", { desc = "Go to previous diagnostic" })
vim.keymap.set("n", "]d", "<cmd>Lspsaga diagnostic_jump_next<cr>", { desc = "Go to next diagnostic" })
vim.keymap.set("n", "<leader>fr", "<cmd>Lspsaga finder<cr>", { desc = "Find references" })
vim.keymap.set("n", "K", "<cmd>Lspsaga hover_doc<cr>", { desc = "Hover documentation" })
vim.keymap.set("n", "<leader>rn", "<cmd>Lspsaga rename<cr>", { desc = "Rename symbol" })
vim.keymap.set("n", "<leader>o", "<cmd>Lspsaga outline<cr>", { desc = "Outline" })

-- Oil file manager
vim.keymap.set("n", "-", "<cmd>Oil<cr>", { desc = "Open Oil" })

-- Terminal mode keymaps
vim.keymap.set("t", "<A-h>", "<C-\\><C-N><C-w>h", { desc = "Move to left window" })
vim.keymap.set("t", "<A-j>", "<C-\\><C-N><C-w>j", { desc = "Move to lower window" })
vim.keymap.set("t", "<A-k>", "<C-\\><C-N><C-w>k", { desc = "Move to upper window" })
vim.keymap.set("t", "<A-l>", "<C-\\><C-N><C-w>l", { desc = "Move to right window" })

-- Window navigation (Alt+hjkl to navigate between panes)
vim.keymap.set("i", "<A-h>", "<C-\\><C-N><C-w>h", { desc = "Move to left window" })
vim.keymap.set("i", "<A-j>", "<C-\\><C-N><C-w>j", { desc = "Move to lower window" })
vim.keymap.set("i", "<A-k>", "<C-\\><C-N><C-w>k", { desc = "Move to upper window" })
vim.keymap.set("i", "<A-l>", "<C-\\><C-N><C-w>l", { desc = "Move to right window" })
vim.keymap.set("n", "<A-h>", "<C-w>h", { desc = "Move to left window" })
vim.keymap.set("n", "<A-j>", "<C-w>j", { desc = "Move to lower window" })
vim.keymap.set("n", "<A-k>", "<C-w>k", { desc = "Move to upper window" })
vim.keymap.set("n", "<A-l>", "<C-w>l", { desc = "Move to right window" })
