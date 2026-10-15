--[[
    FiveRunner's client helper: the client script of the resource that runs
    the tests, which tells the harness once the client started the resources
    of the server, and runs the code that tests give the player.
]]

local load, pcall, tostring = load, pcall, tostring
local table_pack, table_unpack = table.pack, table.unpack

-- Runs code that a test gave the player, with the arguments it gave, and
-- gives the harness back what the code returned or raised. FiveM runs each
-- handler of an event in a thread of its own, so the code may wait.
RegisterNetEvent('fiverunner:run', function(request, code, args)
    local chunk, problem = load(code, '=(run)', 't')
    if chunk == nil then
        TriggerServerEvent('fiverunner:result', request, false, problem)
        return
    end
    local results = table_pack(pcall(chunk, table_unpack(args, 1, args.n)))
    if results[1] then
        TriggerServerEvent('fiverunner:result', request, true, table_pack(table_unpack(results, 2, results.n)))
    else
        local shown, message = pcall(tostring, results[2])
        TriggerServerEvent('fiverunner:result', request, false, shown and message or '(error object is not a string)')
    end
end)

-- The resource that runs the tests starts after those of the project.
TriggerServerEvent('fiverunner:ready')
