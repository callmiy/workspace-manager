local config = require("wks.config")

local M = {}

local function notify(message, level)
  local emit = function()
    vim.notify(message, level, { title = "wks.nvim" })
  end

  if vim.in_fast_event() then
    vim.schedule(emit)
    return
  end

  emit()
end

local function resolve_binary(binary)
  if binary:find("/", 1, true) then
    if vim.fn.executable(binary) == 1 then
      return binary
    end

    return nil
  end

  local resolved = vim.fn.exepath(binary)
  if resolved ~= nil and resolved ~= "" then
    return resolved
  end

  return nil
end

local function current_tabpage()
  return vim.api.nvim_get_current_tabpage()
end

local function terminal_options(bufnr)
  vim.bo[bufnr].buflisted = false
  vim.bo[bufnr].swapfile = false
end

local function terminal_window_options(winnr)
  if not (winnr and vim.api.nvim_win_is_valid(winnr)) then
    return
  end

  vim.wo[winnr].number = false
  vim.wo[winnr].relativenumber = false
  vim.wo[winnr].signcolumn = "no"
  vim.wo[winnr].foldcolumn = "0"
  vim.wo[winnr].statuscolumn = ""
  vim.wo[winnr].wrap = false
end

local function close_float(session)
  if session.win and vim.api.nvim_win_is_valid(session.win) then
    vim.api.nvim_win_close(session.win, true)
  end

  if session.buf and vim.api.nvim_buf_is_valid(session.buf) then
    vim.api.nvim_buf_delete(session.buf, { force = true })
  end
end

local function close_tab(session)
  if session.tabpage and vim.api.nvim_tabpage_is_valid(session.tabpage) then
    local previous = session.previous_tabpage
    if previous and vim.api.nvim_tabpage_is_valid(previous) and previous ~= session.tabpage then
      pcall(vim.api.nvim_set_current_tabpage, previous)
    else
      pcall(vim.api.nvim_set_current_tabpage, session.tabpage)
    end

    if vim.api.nvim_tabpage_is_valid(session.tabpage) then
      pcall(function()
        vim.cmd.tabclose({ bang = true })
      end)
      return
    end
  end

  if session.buf and vim.api.nvim_buf_is_valid(session.buf) then
    vim.api.nvim_buf_delete(session.buf, { force = true })
  end
end

local function cleanup_session(session, opts)
  opts = opts or {}
  if session.closed then
    return
  end

  session.closed = true

  if session.mode == "float" then
    close_float(session)
  else
    close_tab(session)
  end

  if opts.notify_exit and not session.user_closed and session.exit_code ~= 0 then
    notify(string.format("`wks` exited with status %d", session.exit_code), vim.log.levels.ERROR)
  end
end

local function attach_close_autocmd(session)
  vim.api.nvim_create_autocmd({ "BufWipeout", "BufDelete" }, {
    buffer = session.buf,
    once = true,
    callback = function()
      session.user_closed = true
      if session.job_id and vim.fn.jobwait({ session.job_id }, 0)[1] == -1 then
        pcall(vim.fn.jobstop, session.job_id)
      end
      cleanup_session(session, { notify_exit = false })
    end,
  })
end

local function start_terminal(session, command)
  session.job_id = vim.fn.jobstart(command, {
    term = true,
    on_exit = function(_, code)
      session.exit_code = code
      cleanup_session(session, { notify_exit = true })
    end,
  })

  if session.job_id <= 0 then
    cleanup_session(session, { notify_exit = false })
    error(string.format("Failed to launch `%s`", command))
  end

  terminal_options(session.buf)
  terminal_window_options(session.win or vim.api.nvim_get_current_win())
  attach_close_autocmd(session)
  vim.cmd("startinsert")
end

local function open_tab(command)
  local session = {
    mode = "tab",
    previous_tabpage = current_tabpage(),
    exit_code = 0,
    user_closed = false,
    closed = false,
  }

  vim.cmd("tabnew")
  session.tabpage = current_tabpage()
  session.win = vim.api.nvim_get_current_win()
  session.buf = vim.api.nvim_get_current_buf()
  start_terminal(session, command)
end

local function float_dimensions()
  local opts = config.get().float
  local columns = vim.o.columns
  local lines = vim.o.lines - vim.o.cmdheight
  local width = math.max(20, math.floor(columns * opts.width))
  local height = math.max(8, math.floor(lines * opts.height))

  return {
    width = math.min(columns, width),
    height = math.min(lines, height),
    row = math.max(0, math.floor((lines - height) / 2) - 1),
    col = math.max(0, math.floor((columns - width) / 2)),
    border = opts.border,
  }
end

local function open_float(command)
  local session = {
    mode = "float",
    previous_tabpage = current_tabpage(),
    exit_code = 0,
    user_closed = false,
    closed = false,
  }

  session.buf = vim.api.nvim_create_buf(false, true)
  local win_opts = float_dimensions()
  session.win = vim.api.nvim_open_win(session.buf, true, {
    relative = "editor",
    width = win_opts.width,
    height = win_opts.height,
    row = win_opts.row,
    col = win_opts.col,
    style = "minimal",
    border = win_opts.border,
  })

  terminal_window_options(session.win)
  start_terminal(session, command)
end

function M.open(mode)
  local resolved_mode = config.resolve_mode(mode)
  if not config.validate_mode(resolved_mode) then
    notify(string.format("Invalid mode `%s`; expected `tab` or `float`", tostring(resolved_mode)), vim.log.levels.ERROR)
    return false
  end

  local binary = config.get().binary
  local command = resolve_binary(binary)
  if not command then
    notify(string.format("Cannot find executable `%s`", binary), vim.log.levels.ERROR)
    return false
  end

  local ok, err = pcall(function()
    if resolved_mode == "float" then
      open_float(command)
    else
      open_tab(command)
    end
  end)

  if not ok then
    notify(tostring(err), vim.log.levels.ERROR)
    return false
  end

  return true
end

return M
