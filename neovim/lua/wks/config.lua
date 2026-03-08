local M = {}

local defaults = {
  binary = "_wks",
  default_mode = "tab",
  float = {
    width = 0.9,
    height = 0.9,
    border = "rounded",
  },
}

local state = vim.deepcopy(defaults)

local function merge(base, overrides)
  return vim.tbl_deep_extend("force", {}, base, overrides or {})
end

function M.setup(opts)
  state = merge(defaults, opts)
  return state
end

function M.get()
  return state
end

function M.validate_mode(mode)
  if mode == "tab" or mode == "float" then
    return true
  end

  return false
end

function M.resolve_mode(mode)
  if mode == nil or mode == "" then
    return state.default_mode
  end

  return mode
end

return M
