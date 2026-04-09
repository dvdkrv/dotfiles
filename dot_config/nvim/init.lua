vim.g.mapleader = " "
vim.g.maplocalleader = "\\"
vim.g.neovide_input_macos_alt_is_meta = true

-- Disable netrw before oil.nvim loads
vim.g.loaded_netrw = 1
vim.g.loaded_netrwPlugin = 1

-- Enable Lua bytecode cache after all plugins are loaded so the cache is
-- fully populated. Subsequent startups benefit from the warm cache.
vim.api.nvim_create_autocmd('VimEnter', { once = true, callback = vim.loader.enable })

-- Build hooks must be registered before any vim.pack.add() call so they also
-- fire when bootstrapping from the lockfile on a fresh machine.
vim.api.nvim_create_autocmd('PackChanged', { callback = function(ev)
  local name, kind, path = ev.data.spec.name, ev.data.kind, ev.data.path
  if kind == 'install' or kind == 'update' then
    if name == 'telescope-fzf-native.nvim' then
      -- :wait() makes this synchronous so libfzf.so exists before load_extension runs
      vim.system({ 'make' }, { cwd = path }):wait()
    elseif name == 'LuaSnip' then
      vim.system({ 'make', 'install_jsregexp' }, { cwd = path }):wait()
    end
  end
end })

require("utils")
require("config.options")
require("config.keymaps")
