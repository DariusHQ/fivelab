--[[
    FiveRunner events: AddEventHandler, RemoveEventHandler, RegisterNetEvent and
    TriggerEvent, and the routine the runtime calls with each event the
    resource gets.

    The routine runs each handler of the event in a thread of its own, at
    once, going through the handlers with pairs as FiveM does: they sit
    under keys that count up from 11 across all events of the resource. An
    event from the network, with a source of "net:<id>", reaches handlers
    only if RegisterNetEvent made it safe for net. While handlers start,
    `source` is the id of the player the event came from.

    This script also sets up msgpack and json as FiveM's scheduler does, and
    defines the helpers it defines for each side: those that trigger events
    of the other side, and on servers those for players and HTTP requests,
    whose responses come as an event that the script handles before any
    resource script runs, as in FiveM.

    Loaded by the runtime after the scheduler, with its host functions and
    the table the FiveRunner scripts share.
]]

local host, fiverunner = ...

local type, pairs, tonumber, getmetatable = type, pairs, tonumber, getmetatable
local table_unpack, table_insert = table.unpack, table.insert
local debug_getinfo = debug.getinfo
local msgpack_unpack, msgpack_pack_args = msgpack.unpack, msgpack.pack_args

local Citizen = Citizen
local isServer = host.server
local runWithBoundaryEnd = fiverunner.runWithBoundaryEnd

msgpack.set_string('string_compat')
msgpack.set_integer('unsigned')
msgpack.set_array('without_hole')
msgpack.setoption('empty_table_as_array', true)

json.version = json._VERSION
json.setoption('empty_table_as_array', true)
json.setoption('with_hole', true)

--[[ Handlers ]]

-- For each event: its handlers by key, and whether it is safe for net.
local eventHandlers = {}
local eventKey = 10

function AddEventHandler(eventName, eventRoutine)
    local entry = eventHandlers[eventName]
    if not entry then
        entry = {}
        eventHandlers[eventName] = entry
    end
    if not entry.handlers then
        entry.handlers = {}
    end
    eventKey = eventKey + 1
    entry.handlers[eventKey] = eventRoutine
    RegisterResourceAsEventHandler(eventName)
    return {
        key = eventKey,
        name = eventName,
    }
end

function RemoveEventHandler(eventData)
    if not eventData or not eventData.key or not eventData.name then
        error('Invalid event data passed to RemoveEventHandler()', 2)
    end
    eventHandlers[eventData.name].handlers[eventData.key] = nil
end

-- Events that RegisterNetEvent leaves as they are.
local notForNet = {
    ['__cfx_internal:commandFallback'] = true,
}

function RegisterNetEvent(eventName, cb)
    if not notForNet[eventName] then
        local entry = eventHandlers[eventName]
        if not entry then
            entry = {}
            eventHandlers[eventName] = entry
        end
        entry.safeForNet = true
    end
    if cb then
        return AddEventHandler(eventName, cb)
    end
end

-- Like FiveM's, it calls out of the runtime from a boundary, so that stack
-- traces of the runtimes the event reaches show where it was triggered.
function TriggerEvent(eventName, ...)
    local payload = msgpack_pack_args(...)
    return runWithBoundaryEnd(function()
        return TriggerEventInternal(eventName, payload, payload:len())
    end)
end

--[[ Helpers of each side ]]

-- Errors and stack traces name values by the variables that hold them, so
-- those that scripts can see have the names FiveM gives them.
if isServer then
    function TriggerClientEvent(eventName, playerId, ...)
        local payload = msgpack_pack_args(...)
        return TriggerClientEventInternal(eventName, playerId, payload, payload:len())
    end

    function TriggerLatentClientEvent(eventName, playerId, bps, ...)
        local payload = msgpack_pack_args(...)
        return TriggerLatentClientEventInternal(eventName, playerId, payload, payload:len(), tonumber(bps))
    end

    RegisterServerEvent = RegisterNetEvent
    RconPrint = Citizen.Trace
    -- FiveM takes the native when its scheduler loads.
    GetPlayerEP = GetPlayerEndpoint
    RconLog = function() end

    function GetPlayerIdentifiers(player)
        local numIds = GetNumPlayerIdentifiers(player)
        local t = {}
        for i = 0, numIds - 1 do
            table_insert(t, GetPlayerIdentifier(player, i))
        end
        return t
    end

    function GetPlayerTokens(player)
        local numIds = GetNumPlayerTokens(player)
        local t = {}
        for i = 0, numIds - 1 do
            table_insert(t, GetPlayerToken(player, i))
        end
        return t
    end

    function GetPlayers()
        local num = GetNumPlayerIndices()
        local t = {}
        for i = 0, num - 1 do
            table_insert(t, GetPlayerFromIndex(i))
        end
        return t
    end

    -- The callbacks of HTTP requests, by the token of the request, until the
    -- response comes.
    local httpDispatch = {}

    AddEventHandler('__cfx_internal:httpResponse', function(token, status, body, headers, errorData)
        if httpDispatch[token] then
            local userCallback = httpDispatch[token]
            httpDispatch[token] = nil
            userCallback(status, body, headers, errorData)
        end
    end)

    function PerformHttpRequest(url, cb, method, data, headers, options)
        local followLocation = true
        if options and options.followLocation ~= nil then
            followLocation = options.followLocation
        end
        local id = PerformHttpRequestInternalEx({
            url = url,
            method = method or 'GET',
            data = data or '',
            headers = headers or {},
            followLocation = followLocation,
        })
        if id ~= -1 then
            httpDispatch[id] = cb
        else
            cb(0, nil, {}, 'Failure handling HTTP request')
        end
    end

    function PerformHttpRequestAwait(url, method, data, headers, options)
        local p = promise.new()
        PerformHttpRequest(url, function(...)
            p:resolve({ ... })
        end, method, data, headers, options)
        Citizen.Await(p)
        return table.unpack(p.value)
    end
else
    function TriggerServerEvent(eventName, ...)
        local payload = msgpack_pack_args(...)
        return TriggerServerEventInternal(eventName, payload, payload:len())
    end

    function TriggerLatentServerEvent(eventName, bps, ...)
        local payload = msgpack_pack_args(...)
        return TriggerLatentServerEventInternal(eventName, payload, payload:len(), tonumber(bps))
    end
end

--[[ The event routine ]]

-- Like FiveM's, it looks up string methods, Citizen.Trace and
-- Citizen.CreateThreadNow when it runs.
Citizen.SetEventRoutine(function(eventName, eventPayload, eventSource)
    local lastSource = _G.source
    _G.source = eventSource

    local entry = eventHandlers[eventName]
    -- FiveM unpacks the payload even for events without handlers.
    local data = msgpack_unpack(eventPayload)

    if entry and entry.handlers then
        if eventSource:sub(1, 3) == 'net' then
            if not entry.safeForNet then
                Citizen.Trace('event ' .. eventName .. ' was not safe for net\n')
                _G.source = lastSource
                return
            end
            _G.source = tonumber(eventSource:sub(5))
        elseif isServer and eventSource:sub(1, 12) == 'internal-net' then
            _G.source = tonumber(eventSource:sub(14))
        end

        if not data then
            data = {}
        end

        if type(data) == 'table' then
            for _, handler in pairs(entry.handlers) do
                local fn = handler
                local mt = getmetatable(fn)
                if mt and mt.__call then
                    fn = mt.__call
                end
                if type(fn) == 'function' then
                    local info = debug_getinfo(fn, 'S')
                    Citizen.CreateThreadNow(function()
                        handler(table_unpack(data))
                    end, ('event %s [%s[%d..%d]]'):format(eventName, info.short_src, info.linedefined, info.lastlinedefined))
                end
            end
        end
    end

    _G.source = lastSource
end)
