return {
	"nvim-telescope/telescope.nvim",
	branch = "0.1.x",
	cmd = "Telescope",
	dependencies = {
		"nvim-lua/plenary.nvim",
		"telescope-fzf-native.nvim",
	},
	config = function()
		local telescope = require("telescope")
		local actions = require("telescope.actions")

		telescope.setup({
			defaults = {
				path_display = { "smart" },
				-- Handle large files and long lines better
				preview = {
					filesize_limit = 1, -- MB - skip preview for files larger than this
					timeout = 250, -- ms - timeout for preview
				},
				-- Search hidden files
				vimgrep_arguments = {
					"rg",
					"--color=never",
					"--no-heading",
					"--with-filename",
					"--line-number",
					"--column",
					"--smart-case",
					"--hidden", -- Search hidden files
					"--glob",
					"!**/.git/*", -- But ignore .git directory
				},
				file_ignore_patterns = { ".git/" },
				mappings = {
					n = {
						["dd"] = actions.delete_buffer,
					},
				},
			},
			pickers = {
				find_files = {
					hidden = true, -- Show hidden files in find_files
					find_command = { "rg", "--files", "--hidden", "--glob", "!**/.git/*" },
				},
			},
			extensions = {
				fzf = {
					fuzzy = true,
					override_generic_sorter = true,
					override_file_sorter = true,
					case_mode = "smart_case",
				},
			},
		})

		-- Load extensions
		telescope.load_extension("fzf")
	end,
}
