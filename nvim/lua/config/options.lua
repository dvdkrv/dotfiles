-- General settings
vim.opt.mouse = "a" -- Enable mouse support
vim.opt.clipboard = "unnamedplus" -- Use system clipboard
vim.opt.undofile = true -- Persistent undo
vim.opt.undolevels = 10000
vim.opt.backup = false
vim.opt.writebackup = false
vim.opt.swapfile = false
vim.opt.sessionoptions = { "buffers", "curdir", "tabpages", "winsize", "help", "globals", "skiprtp", "folds" }

-- UI settings
vim.opt.termguicolors = true -- True color support
vim.opt.number = true
vim.opt.relativenumber = true
vim.opt.numberwidth = 4 -- Width of number column
vim.opt.cursorline = true -- Highlight cursor line
vim.opt.signcolumn = "yes" -- Always show sign column (prevents shift)
vim.opt.scrolloff = 5 -- Lines to keep above/below cursor
vim.opt.sidescrolloff = 8 -- Columns to keep left/right of cursor
vim.opt.showmode = false -- Don't show mode (lualine shows it)
vim.opt.conceallevel = 2
vim.opt.pumheight = 10 -- Max items in completion menu
vim.opt.pumblend = 0 -- Transparency for popups
vim.opt.winblend = 0 -- Transparency for floating windows

-- Splits
vim.opt.splitright = true -- Vertical splits to the right
vim.opt.splitbelow = true -- Horizontal splits below

-- Editing
vim.opt.wrap = false -- Don't wrap long lines
vim.opt.linebreak = true -- Wrap at word boundaries
vim.opt.expandtab = true -- Use spaces instead of tabs
vim.opt.tabstop = 2 -- Number of spaces tabs count for
vim.opt.shiftwidth = 2 -- Size of indent
vim.opt.softtabstop = 2
vim.opt.shiftround = true -- Round indent to multiple of shiftwidth
vim.opt.smartindent = true -- Auto indent
vim.opt.autoindent = true
vim.opt.breakindent = true -- Wrapped lines continue indented
vim.opt.virtualedit = "block" -- Allow cursor to move where there is no text in visual block mode
vim.opt.inccommand = "split" -- Preview substitutions live in a split

-- Search
vim.opt.ignorecase = true -- Ignore case when searching
vim.opt.smartcase = true -- Override ignorecase if search contains uppercase
vim.opt.hlsearch = true -- Highlight search results
vim.opt.incsearch = true -- Incremental search
vim.opt.grepprg = "rg --vimgrep" -- Use ripgrep for grep
vim.opt.grepformat = "%f:%l:%c:%m"

-- Performance
vim.opt.updatetime = 250 -- Faster completion & git signs
vim.opt.timeoutlen = 300 -- Time to wait for key sequence
vim.opt.lazyredraw = false -- Don't redraw during macros (set to true if slow)

-- Completion
vim.opt.completeopt = "menu,menuone,noselect" -- Better completion

-- Wildmenu
vim.opt.wildmode = "longest:full,full" -- Command line completion
vim.opt.wildignore = { "*.o", "*.a", "__pycache__", "*.pyc", "node_modules/**", ".git/**" }

-- Format options
vim.opt.formatoptions = "jcroqlnt" -- Auto-format options

-- Diagnostics
vim.diagnostic.config({
	virtual_text = false,
	float = { header = false, border = "rounded" },
	signs = true,
	underline = true,
	update_in_insert = false,
	severity_sort = true,
})

-- Let terminal handle cursor shape and color
vim.api.nvim_set_hl(0, "Cursor", {})

-- Ensure transparency for floating windows and borders, but keep cursorline visible
local function apply_transparency()
	vim.api.nvim_set_hl(0, "NormalFloat", { bg = "NONE" })
	vim.api.nvim_set_hl(0, "FloatBorder", { bg = "NONE" })
	vim.api.nvim_set_hl(0, "Pmenu", { bg = "NONE" })
	-- Make CursorLine visible with Catppuccin surface color
	vim.api.nvim_set_hl(0, "CursorLine", { bg = "#313244" })
end

-- Apply on startup and after colorscheme changes
apply_transparency()
vim.api.nvim_create_autocmd("ColorScheme", {
	callback = apply_transparency,
})
