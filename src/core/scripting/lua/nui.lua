--[[
    FiveRunner NUI helpers for clients: RegisterNuiCallback and
    RegisterNUICallback, which report the errors of their callbacks, and
    SendNUIMessage, which encodes its message as JSON.

    RegisterNuiCallback registers the callback with the native of its name.
    RegisterNUICallback, the older of the two, registers the type with
    RegisterNuiCallbackType and handles the event __cfx_nui:<type>, as
    FiveM's does.

    Loaded by the runtime of clients after the exports script.
]]

local Citizen = Citizen

-- FiveM takes the natives when its scheduler loads.
local registerNuiCallback = RegisterNuiCallback
local sendNuiMessage = SendNuiMessage

-- Calls a callback with the body of a NUI request and the function that
-- answers it, catching its error. The callback is called through a variable
-- named callback, which stack traces name it by, as in FiveM.
local function handle(callback, body, resultCallback)
    local status, err = pcall(function()
        callback(body, resultCallback)
    end)
    return status, err
end

-- Handles a NUI request of `type` with `callback`, reporting its error.
local function handler(type, callback)
    return function(body, resultCallback)
        local _, err = handle(callback, body, resultCallback)
        if err then
            Citizen.Trace('error during NUI callback ' .. type .. ': ' .. tostring(err) .. '\n')
        end
    end
end

function RegisterNuiCallback(type, callback)
    registerNuiCallback(type, handler(type, callback))
end

function RegisterNUICallback(type, callback)
    RegisterNuiCallbackType(type)
    AddEventHandler('__cfx_nui:' .. type, handler(type, callback))
end

function SendNUIMessage(message)
    sendNuiMessage(json.encode(message))
end
