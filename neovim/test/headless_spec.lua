local repo_root = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":p:h:h")
vim.opt.runtimepath:prepend(repo_root)

local wks = require("wks")

local function fail(message)
  error(message, 0)
end

local function assert_eq(actual, expected, message)
  if actual ~= expected then
    fail(string.format("%s: expected `%s`, got `%s`", message, tostring(expected), tostring(actual)))
  end
end

local function assert_true(value, message)
  if not value then
    fail(message)
  end
end

local notified = {}
local original_notify = vim.notify
vim.notify = function(message, level, opts)
  table.insert(notified, {
    message = tostring(message),
    level = level,
    title = opts and opts.title or nil,
  })
end

local function write_file(path, lines)
  vim.fn.writefile(lines, path)
end

local temp_root = vim.fn.tempname()
vim.fn.mkdir(temp_root, "p")

local stub_ok = temp_root .. "/wks-ok"
local stub_fail = temp_root .. "/wks-fail"
write_file(stub_ok, {
  "#!/bin/sh",
  "sleep 0.1",
  "exit 0",
})
write_file(stub_fail, {
  "#!/bin/sh",
  "sleep 0.1",
  "exit 7",
})
vim.fn.system({ "chmod", "+x", stub_ok, stub_fail })

local function count_tabs()
  return #vim.api.nvim_list_tabpages()
end

local function current_window_is_float()
  local win = vim.api.nvim_get_current_win()
  local cfg = vim.api.nvim_win_get_config(win)
  return cfg.relative ~= ""
end

local function wait_for(condition, message)
  local ok = vim.wait(1500, condition, 20)
  assert_true(ok, message)
end

local function reset_notifications()
  notified = {}
end

local function has_notification(fragment, level)
  for _, item in ipairs(notified) do
    if item.message:find(fragment, 1, true) and (level == nil or item.level == level) then
      return true
    end
  end

  return false
end

wks.setup({
  binary = stub_ok,
  default_mode = "tab",
})

local initial_tab_count = count_tabs()
wks.open()
assert_eq(count_tabs(), initial_tab_count + 1, "tab mode should open a new tab")
wait_for(function()
  return count_tabs() == initial_tab_count
end, "tab mode should close after process exit")

reset_notifications()
wks.open("float")
assert_true(current_window_is_float(), "float mode should open a floating terminal window")
wait_for(function()
  return not current_window_is_float()
end, "float mode should close after process exit")
assert_true(#notified == 0, "successful runs should not notify")

reset_notifications()
wks.setup({
  binary = temp_root .. "/missing-wks",
  default_mode = "tab",
})
wks.open()
assert_true(has_notification("Cannot find executable", vim.log.levels.ERROR), "missing binary should notify")

reset_notifications()
wks.setup({
  binary = stub_fail,
  default_mode = "tab",
})
wks.open()
wait_for(function()
  return has_notification("exited with status 7", vim.log.levels.ERROR)
end, "non-zero exit should notify")

vim.notify = original_notify
print("headless_spec.lua: ok")
