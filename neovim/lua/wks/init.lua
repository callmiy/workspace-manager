local config = require("wks.config")
local ui = require("wks.ui")

local M = {}

function M.setup(opts)
  return config.setup(opts)
end

function M.open(mode)
  return ui.open(mode)
end

return M
