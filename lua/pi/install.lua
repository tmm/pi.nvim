local M = {}

local function done(callback, ...)
  if not callback then
    return
  end

  local args = { ... }
  vim.schedule(function()
    callback(table.unpack(args))
  end)
end

local function plugin_root()
  local source = debug.getinfo(1, "S").source:sub(2)
  return vim.fs.dirname(vim.fs.dirname(vim.fs.dirname(source)))
end

local function bundled_extension_path()
  return vim.fs.joinpath(plugin_root(), "extension", "index.ts")
end

local function package_json_path()
  return vim.fs.joinpath(plugin_root(), "package.json")
end

local function installed_extension_path()
  return vim.fs.joinpath(vim.fn.expand("~"), ".pi", "agent", "extensions", "pi-nvim.ts")
end

local function legacy_installed_extension_path()
  return vim.fs.joinpath(vim.fn.expand("~"), ".pi", "agent", "extensions", "pi-nvim-bridge.ts")
end

local function read_file(path)
  local ok, lines = pcall(vim.fn.readfile, path)
  if not ok then
    return nil
  end
  return table.concat(lines, "\n")
end

local function extension_version()
  local pkg = read_file(package_json_path())
  if not pkg then
    return "unknown"
  end

  local ok, decoded = pcall(vim.json.decode, pkg)
  if not ok or type(decoded) ~= "table" or type(decoded.version) ~= "string" then
    return "unknown"
  end

  return decoded.version
end

local function version_header()
  return "// pi.nvim extension version: " .. extension_version() .. "\n"
end

local function installable_extension_content()
  local src_content = read_file(bundled_extension_path())
  if not src_content then
    return nil
  end
  return version_header() .. src_content
end

function M.version()
  return extension_version()
end

function M.installed_version()
  local content = read_file(installed_extension_path())
  if not content then
    return nil
  end

  return content:match("^// pi%.nvim extension version: ([^\n]+)")
end

function M.install(opts)
  opts = opts or {}
  local dest = installed_extension_path()
  local legacy_dest = legacy_installed_extension_path()
  local src_content = installable_extension_content()

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
  pcall(vim.uv.fs_unlink, legacy_dest)

  if opts.notify then
    vim.notify("pi.nvim extension installed: " .. dest .. " (run /reload in pi)", vim.log.levels.INFO)
  end

  return true
end

function M.install_async(opts, callback)
  opts = opts or {}
  local src = bundled_extension_path()
  local dest = installed_extension_path()
  local legacy_dest = legacy_installed_extension_path()
  local header = version_header()

  vim.uv.fs_open(src, "r", 438, function(open_err, src_fd)
    if open_err or not src_fd then
      if opts.notify then
        vim.notify("pi.nvim: could not read bundled pi extension", vim.log.levels.ERROR)
      end
      done(callback, false)
      return
    end

    vim.uv.fs_fstat(src_fd, function(stat_err, stat)
      if stat_err or not stat then
        vim.uv.fs_close(src_fd)
        if opts.notify then
          vim.notify("pi.nvim: could not read bundled pi extension", vim.log.levels.ERROR)
        end
        done(callback, false)
        return
      end

      vim.uv.fs_read(src_fd, stat.size, 0, function(read_err, src_content)
        vim.uv.fs_close(src_fd)
        if read_err or not src_content then
          if opts.notify then
            vim.notify("pi.nvim: could not read bundled pi extension", vim.log.levels.ERROR)
          end
          done(callback, false)
          return
        end

        src_content = header .. src_content

        vim.uv.fs_open(dest, "r", 438, function(dest_open_err, dest_fd)
          local function write_dest()
            vim.uv.fs_mkdir(vim.fs.dirname(dest), 493, function(mkdir_err)
              if mkdir_err and mkdir_err:match("^EEXIST") == nil then
                if opts.notify then
                  vim.notify("pi.nvim: could not create pi extension directory", vim.log.levels.ERROR)
                end
                done(callback, false)
                return
              end

              vim.uv.fs_open(dest, "w", 420, function(write_open_err, write_fd)
                if write_open_err or not write_fd then
                  if opts.notify then
                    vim.notify("pi.nvim: could not open pi extension destination", vim.log.levels.ERROR)
                  end
                  done(callback, false)
                  return
                end

                vim.uv.fs_write(write_fd, src_content, 0, function(write_err)
                  vim.uv.fs_close(write_fd)
                  if write_err then
                    if opts.notify then
                      vim.notify("pi.nvim: could not install pi extension", vim.log.levels.ERROR)
                    end
                    done(callback, false)
                    return
                  end

                  vim.uv.fs_unlink(legacy_dest, function() end)
                  if opts.notify then
                    vim.notify("pi.nvim extension installed: " .. dest .. " (run /reload in pi)", vim.log.levels.INFO)
                  end
                  done(callback, true)
                end)
              end)
            end)
          end

          if dest_open_err or not dest_fd then
            write_dest()
            return
          end

          vim.uv.fs_fstat(dest_fd, function(dest_stat_err, dest_stat)
            if dest_stat_err or not dest_stat then
              vim.uv.fs_close(dest_fd)
              write_dest()
              return
            end

            vim.uv.fs_read(dest_fd, dest_stat.size, 0, function(dest_read_err, current)
              vim.uv.fs_close(dest_fd)
              if not opts.force and not dest_read_err and current == src_content then
                done(callback, true)
                return
              end
              write_dest()
            end)
          end)
        end)
      end)
    end)
  end)
end

return M
