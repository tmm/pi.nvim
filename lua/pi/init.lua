---@class PiNvimOptions
---@field auto_start? boolean
---@field auto_install_pi_extension? boolean
---@field debounce_ms? number
---@field notify_on_install? boolean

---@class PiNvimServer
---@field handle uv_tcp_t
---@field host string
---@field port integer
---@field token string

local M = {
  enabled = false,
  ---@type PiNvimServer|nil
  server = nil,
  sequence = 0,
  last_visual_selection = nil,
  ---@type PiNvimOptions
  opts = {},
}

local function current_buf()
  return vim.api.nvim_get_current_buf()
end

local function bridge_base_dir()
  return vim.fs.joinpath(vim.fn.stdpath("cache"), "pi-bridge")
end

local function current_file(buf)
  local name = vim.api.nvim_buf_get_name(buf)
  return name ~= "" and name or nil
end

local function project_root(buf)
  local ok, root = pcall(function()
    local util_root = require("util.root")
    if util_root and util_root.get then
      return util_root.get({ buf = buf, normalize = true })
    end
  end)
  if ok and root and root ~= "" then
    return root
  end
  return vim.uv.cwd()
end

local function project_root_id(buf)
  local root = project_root(buf)
  local name = vim.fs.basename(root):gsub("[^%w%-_]", "-")
  local hash = vim.fn.sha256(root):sub(1, 12)
  return name .. "-" .. hash
end

local function bridge_dir(buf)
  return vim.fs.joinpath(bridge_base_dir(), project_root_id(buf or current_buf()))
end

local function lockfile_path(buf)
  return vim.fs.joinpath(bridge_dir(buf), "lock.json")
end

local function ensure_bridge_dir(buf)
  vim.fn.mkdir(bridge_dir(buf), "p")
end

local function relative_path(path, root)
  if not path or not root then
    return nil
  end

  local prefix = root
  if not prefix:match("/$") then
    prefix = prefix .. "/"
  end

  if path == root then
    return vim.fs.basename(path)
  end

  if path:sub(1, #prefix) == prefix then
    return path:sub(#prefix + 1)
  end

  return vim.fn.fnamemodify(path, ":.")
end

local function get_cursor()
  local cursor = vim.api.nvim_win_get_cursor(0)
  return { line = cursor[1], col = cursor[2] }
end

local function get_buffer_text(buf)
  return table.concat(vim.api.nvim_buf_get_lines(buf, 0, -1, false), "\n")
end

local function get_visual_selection(buf)
  local mode = vim.fn.mode()
  if mode ~= "v" and mode ~= "V" and mode ~= "\22" then
    return nil
  end

  local start_pos = vim.fn.getpos("v")
  local end_pos = vim.fn.getpos(".")
  if start_pos[2] == 0 or end_pos[2] == 0 then
    return nil
  end

  local start_line, start_col = start_pos[2], start_pos[3] - 1
  local end_line, end_col = end_pos[2], end_pos[3] - 1

  if start_line > end_line or (start_line == end_line and start_col > end_col) then
    start_line, end_line = end_line, start_line
    start_col, end_col = end_col, start_col
  end

  local lines
  if mode == "V" then
    local selected_lines = vim.api.nvim_buf_get_lines(buf, start_line - 1, end_line, false)
    lines = selected_lines
    start_col = 0
    end_col = #(selected_lines[#selected_lines] or "")
  else
    lines = vim.api.nvim_buf_get_text(buf, start_line - 1, start_col, end_line - 1, end_col + 1, {})
  end

  return {
    active = true,
    start = { line = start_line, col = start_col },
    ["end"] = { line = end_line, col = end_col },
    text = table.concat(lines, "\n"),
  }
end

local function get_selection(buf)
  local selection = get_visual_selection(buf)
  if selection then
    M.last_visual_selection = vim.deepcopy(selection)
    return selection
  end

  if M.last_visual_selection then
    local last = vim.deepcopy(M.last_visual_selection)
    last.active = false
    return last
  end

  return { active = false, text = "" }
end

local function format_diagnostic(diagnostic)
  local severity = vim.diagnostic.severity[diagnostic.severity]

  return {
    lnum = diagnostic.lnum + 1,
    col = diagnostic.col,
    end_lnum = diagnostic.end_lnum and (diagnostic.end_lnum + 1) or nil,
    end_col = diagnostic.end_col,
    severity = severity,
    source = diagnostic.source,
    code = diagnostic.code,
    message = diagnostic.message,
  }
end

local function collect_payload()
  local buf = current_buf()
  local file = current_file(buf)
  local root = project_root(buf)
  local diagnostics = vim.tbl_map(format_diagnostic, vim.diagnostic.get(buf))
  local selection = get_selection(buf)
  local context = {
    bufnr = buf,
    cwd = vim.uv.cwd(),
    project_root = root,
    bridge_dir = bridge_dir(buf),
    file = file,
    relative_path = relative_path(file, root),
    filetype = vim.bo[buf].filetype,
    modified = vim.bo[buf].modified,
    cursor = get_cursor(),
    selection = {
      active = selection.active,
      start = selection.start,
      ["end"] = selection["end"],
    },
    diagnostics_count = #diagnostics,
    nvim = {
      pid = vim.fn.getpid(),
      servername = vim.v.servername,
      version = string.format("%d.%d.%d", vim.version().major, vim.version().minor, vim.version().patch),
    },
    updated_at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
  }

  return {
    context = context,
    buffer = get_buffer_text(buf),
    selection = selection.text or "",
    diagnostics = diagnostics,
  }
end

local function write_lockfile(buf)
  if not M.server then
    return
  end

  ensure_bridge_dir(buf)
  local lockfile = {
    host = "127.0.0.1",
    port = M.server.port,
    token = M.server.token,
    project_root = project_root(buf),
    bridge_dir = bridge_dir(buf),
    pid = vim.fn.getpid(),
    updated_at = os.date("!%Y-%m-%dT%H:%M:%SZ"),
  }

  vim.fn.writefile({ vim.json.encode(lockfile) }, lockfile_path(buf))
end

local function remove_lockfile(buf)
  pcall(vim.uv.fs_unlink, lockfile_path(buf))
end

local function build_response(target)
  local payload = collect_payload()

  if target == "context" then
    return { ok = true, target = target, context = payload.context }
  elseif target == "current" then
    return { ok = true, target = target, context = payload.context, text = payload.buffer }
  elseif target == "selection" then
    return { ok = true, target = target, context = payload.context, text = payload.selection }
  elseif target == "diagnostics" then
    return { ok = true, target = target, context = payload.context, diagnostics = payload.diagnostics }
  end

  return {
    ok = true,
    target = target,
    context = payload.context,
    text = payload.buffer,
    selection = payload.selection,
    diagnostics = payload.diagnostics,
  }
end

local function handle_client(client)
  local chunks = {}
  local responded = false

  local function respond(response)
    if responded then
      return
    end
    responded = true

    client:read_stop()
    client:write(vim.json.encode(response) .. "\n", function()
      client:shutdown(function()
        client:close()
      end)
    end)
  end

  client:read_start(vim.schedule_wrap(function(err, chunk)
    if err then
      respond({ ok = false, error = err })
      return
    end

    if chunk then
      table.insert(chunks, chunk)
      local raw = table.concat(chunks)
      if not raw:find("\n", 1, true) then
        return
      end

      local line = raw:match("^(.-)\n") or raw
      local ok, request = pcall(vim.json.decode, line)
      if not ok then
        respond({ ok = false, error = "invalid json request" })
      elseif not M.server or request.token ~= M.server.token then
        respond({ ok = false, error = "unauthorized" })
      else
        respond(build_response(request.target or "current"))
      end
      return
    end

    local raw = table.concat(chunks)
    local ok, request = pcall(vim.json.decode, raw)
    if not ok then
      respond({ ok = false, error = "invalid json request" })
    elseif not M.server or request.token ~= M.server.token then
      respond({ ok = false, error = "unauthorized" })
    else
      respond(build_response(request.target or "current"))
    end
  end))
end

local function stop_server()
  if not M.server then
    return
  end

  local server = M.server.handle
  M.server = nil
  if server then
    server:close()
  end
  remove_lockfile(current_buf())
end

local function start_server()
  if M.server then
    return
  end

  local server = assert(vim.uv.new_tcp())
  local token = vim.fn.sha256(tostring(vim.loop.hrtime()) .. tostring(vim.fn.getpid()))

  assert(server:bind("127.0.0.1", 0))
  server:listen(128, vim.schedule_wrap(function(err)
    assert(not err, err)
    local client = vim.uv.new_tcp()
    local ok = server:accept(client)
    if not ok then
      client:close()
      return
    end
    handle_client(client)
  end))

  local address = server:getsockname()
  M.server = {
    handle = server,
    host = "127.0.0.1",
    port = address.port,
    token = token,
  }

  write_lockfile(current_buf())
end

function M.refresh()
  if not M.enabled then
    return
  end

  if not M.server then
    start_server()
  end

  write_lockfile(current_buf())
end

function M.refresh_debounced()
  M.sequence = M.sequence + 1
  local sequence = M.sequence

  vim.defer_fn(function()
    if sequence == M.sequence then
      M.refresh()
    end
  end, M.opts.debounce_ms)
end

function M.status()
  local path = lockfile_path(current_buf())
  local ok = vim.uv.fs_stat(path) ~= nil
  local message = ok and ("pi.nvim bridge active: " .. path) or ("pi.nvim bridge missing: " .. path)
  vim.notify(message, vim.log.levels.INFO)
  return path
end

function M.copy_ref(opts)
  opts = opts or {}
  local ref = opts.selection and "@nvim:selection" or "@nvim:current"
  vim.fn.setreg("+", ref)
  vim.fn.setreg('"', ref)
  vim.notify("Copied " .. ref, vim.log.levels.INFO)
end

function M.enable()
  M.enabled = true
  start_server()
  M.refresh()
end

function M.disable()
  M.enabled = false
  stop_server()
end

---@param opts? PiNvimOptions
function M.setup(opts)
  M.opts = vim.tbl_deep_extend("force", {
    auto_start = true,
    auto_install_pi_extension = true,
    debounce_ms = 100,
    notify_on_install = true,
  }, opts or {})

  if M.opts.auto_install_pi_extension then
    require("pi.install").install({ notify = M.opts.notify_on_install })
  end

  local group = vim.api.nvim_create_augroup("pi_nvim_bridge", { clear = true })

  vim.api.nvim_create_user_command("PiBridgeEnable", function()
    M.enable()
  end, { desc = "Enable pi.nvim bridge" })

  vim.api.nvim_create_user_command("PiBridgeDisable", function()
    M.disable()
  end, { desc = "Disable pi.nvim bridge" })

  vim.api.nvim_create_user_command("PiBridgeRefresh", function()
    M.refresh()
  end, {
    desc = "Refresh pi.nvim bridge context",
    range = true,
  })

  vim.api.nvim_create_user_command("PiBridgeStatus", function()
    M.status()
  end, { desc = "Show pi.nvim bridge status" })

  vim.api.nvim_create_user_command("PiBridgeCopyRef", function(opts2)
    M.copy_ref({ selection = opts2.range > 0 })
  end, {
    desc = "Copy pi.nvim bridge ref",
    range = true,
  })

  vim.api.nvim_create_user_command("PiBridgeInstallExtension", function()
    require("pi.install").install({ force = true, notify = true })
  end, { desc = "Install pi.nvim extension for pi" })

  vim.api.nvim_create_autocmd({
    "BufEnter",
    "BufWritePost",
    "CursorMoved",
    "CursorMovedI",
    "ModeChanged",
    "TextChanged",
    "TextChangedI",
  }, {
    group = group,
    callback = function()
      M.refresh_debounced()
    end,
  })

  vim.api.nvim_create_autocmd("VimLeavePre", {
    group = group,
    callback = function()
      stop_server()
    end,
  })

  if M.opts.auto_start then
    M.enable()
  end
end

return M
