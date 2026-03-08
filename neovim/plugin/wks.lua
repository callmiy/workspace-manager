if vim.g.loaded_wks_plugin == 1 then
  return
end

vim.g.loaded_wks_plugin = 1

vim.api.nvim_create_user_command("Wks", function(command_opts)
  local mode = command_opts.fargs[1]
  require("wks").open(mode)
end, {
  nargs = "?",
  complete = function()
    return { "tab", "float" }
  end,
  desc = "Launch _wks in a terminal tab or floating terminal",
})
