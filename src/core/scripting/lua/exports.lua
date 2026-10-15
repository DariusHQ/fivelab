--[[
    FiveRunner exports: the exports table, through which scripts call the
    functions that resources export.

    A resource exports a function under a name with exports(name, fn), or by
    naming a global in its manifest: in export entries on clients, and in
    server_export entries on servers. Either way it handles the event
    __cfx_export_<resource>_<name>, which carries a callback, by calling the
    callback with the function, as in FiveM. The handlers for the manifest
    are added before any resource script runs.

    exports.resource.name triggers that event, keeps the function it gets,
    a proxy, until a resource stops, and returns a function that calls it
    with the arguments after the first, which exports.resource:name(...)
    passes the table as. An error of the export is raised again with the
    export and the resource named.

    Loaded by the runtime after the references script, with its host
    functions.
]]

local host = ...

local type, error, setmetatable = type, error, setmetatable

local isServer = host.server

-- The event that a resource handles to give the function it exports as
-- `name`. FiveM gives txAdmin's under the name it had, monitor.
local function exportEvent(resource, name)
    if resource == 'txAdmin' then
        resource = 'monitor'
    end
    return string.format('__cfx_export_%s_%s', resource, name)
end

-- The functions that exports gave, by resource and name.
local exported = {}

do
    local resource = host.resource
    for _, exportName in ipairs({ host.manifestExports() }) do
        AddEventHandler(exportEvent(resource, exportName), function(setCB)
            -- FiveM looks the global up when the export is asked for.
            if _G[exportName] then
                setCB(_G[exportName])
            end
        end)
    end
end

-- Forgets the functions of resources that stop, from when the exports of
-- another resource are first asked for.
local watching = false

local function watchStops()
    if watching then
        return
    end
    AddEventHandler(('on%sResourceStop'):format(isServer and 'Server' or 'Client'), function(resource)
        exported[resource] = {}
    end)
    watching = true
end

-- Puts `prefix` before each line of `text`.
local function indent(text, prefix)
    text = tostring(text)
    if #text == 0 then
        return text
    end
    return prefix .. text:gsub('\n(.)', '\n' .. prefix .. '%1')
end

-- Returns the results of an export that pcall called, or raises its error
-- again from where the export was called, with long errors cut short.
local function settle(resource, name, ok, ...)
    if not ok then
        local err = tostring(select(1, ...))
        if err:len() > 2048 then
            err = err:sub(1, 1024) .. '\n... [large output partially truncated] ...\n' .. err:sub(-1024)
        end
        error(('\n^5 An error occurred while calling export `%s` in resource `%s`:\n%s\n^5 ---'):format(
            name, resource, indent(err, '  ')), 2)
    end
    return ...
end

exports = setmetatable({}, {
    __index = function(_, resource)
        return setmetatable({}, {
            __index = function(_, name)
                watchStops()
                if not name or type(name) ~= 'string' then
                    error('Invalid export name: ' .. tostring(name), 2)
                end
                if not exported[resource] then
                    exported[resource] = {}
                end
                if not exported[resource][name] then
                    TriggerEvent(exportEvent(resource, name), function(fn)
                        exported[resource][name] = fn
                    end)
                    if not exported[resource][name] then
                        error('No such export ' .. name .. ' in resource ' .. resource, 2)
                    end
                end
                -- Looks the function up when it runs, and tail calls settle,
                -- so that its errors point at the caller.
                return function(self, ...)
                    return settle(resource, name, pcall(exported[resource][name], ...))
                end
            end,
            __newindex = function()
                error('cannot set values on an export resource', 2)
            end,
        })
    end,
    __newindex = function()
        error('cannot set values on exports', 2)
    end,
    __call = function(_, exportName, func)
        AddEventHandler(exportEvent(GetCurrentResourceName(), exportName), function(setCB)
            setCB(func)
        end)
    end,
})
