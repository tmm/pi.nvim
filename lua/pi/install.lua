local M = {}

local function plugin_root()
  local source = debug.getinfo(1, "S").source:sub(2)
  return vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
end

local function bundled_extension_path()
  return vim.fs.joinpath(plugin_root(), "pi-extension", "pi-nvim-bridge.ts")
end

local function installed_extension_path()
  return vim.fs.joinpath(vim.fn.expand("~"), ".pi", "agent", "extensions", "pi-nvim-bridge.ts")
end

local function read_file(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then
    return nil
  end
  return table.concat(lines, "\n")
end

function M.install(opts)
  opts = opts or {}
  local src = bundled_extension_path()
  local dest = installed_extension_path()
  local src_content = read_file(src)

  if not src_content then
    if opts.notify then
      vim.notify("pi.nvim: could not read bundled pi extension", vim.log.levels.ERROR)
    end
    return false
  end

  local current = read_file(dest)
  if not opts.force and current == src_content then
    return true
  end

  vim.fn.mkdir(vim.fs.dirname(dest), "p")
  vim.fn.writefile(vim.split(src_content, "\n", { plain = true }), dest)

  if opts.notify then
    vim.notify("pi.nvim extension installed: " .. dest .. " (run /reload in pi)", vim.log.levels.INFO)
  end

  return true
end

return M
