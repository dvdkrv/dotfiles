return {
	"ThePrimeagen/harpoon",
	branch = "harpoon2",
	dependencies = { "nvim-lua/plenary.nvim" },
	keys = {
		{ "<leader>a", desc = "Harpoon add file" },
		{ "<C-e>", desc = "Harpoon menu" },
		{ "<leader>h1", desc = "Harpoon file 1" },
		{ "<leader>h2", desc = "Harpoon file 2" },
		{ "<leader>h3", desc = "Harpoon file 3" },
		{ "<leader>h4", desc = "Harpoon file 4" },
		{ "<C-S-P>", desc = "Harpoon prev" },
		{ "<C-S-N>", desc = "Harpoon next" },
	},
	config = function()
		local harpoon = require("harpoon")
		harpoon.setup({})
		-- harpoon keymaps
		vim.keymap.set("n", "<leader>a", function()
			harpoon:list():add()
		end, { desc = "Harpoon add file" })
		vim.keymap.set("n", "<C-e>", function()
			harpoon.ui:toggle_quick_menu(harpoon:list())
		end, { desc = "Harpoon menu" })

		vim.keymap.set("n", "<leader>h1", function()
			harpoon:list():select(1)
		end, { desc = "Harpoon file 1" })
		vim.keymap.set("n", "<leader>h2", function()
			harpoon:list():select(2)
		end, { desc = "Harpoon file 2" })
		vim.keymap.set("n", "<leader>h3", function()
			harpoon:list():select(3)
		end, { desc = "Harpoon file 3" })
		vim.keymap.set("n", "<leader>h4", function()
			harpoon:list():select(4)
		end, { desc = "Harpoon file 4" })

		-- Toggle previous & next buffers stored within Harpoon list
		vim.keymap.set("n", "<C-S-P>", function()
			harpoon:list():prev()
		end, { desc = "Harpoon prev" })
		vim.keymap.set("n", "<C-S-N>", function()
			harpoon:list():next()
		end, { desc = "Harpoon next" })
	end,
}
