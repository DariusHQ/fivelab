-- Runs resource manifests as FiveM does. Every global that a manifest reads
-- and no one set is a function that adds manifest entries named after it:
--
--   name 'value'      adds name = value
--   names { 'a' }     adds name = a, for each value of the table, named
--                     without a final s, so client_scripts adds client_script
--
-- What that function returns adds name_extra, the JSON of the value it gets,
-- for manifests that write name 'value' { ... }.
--
-- The chunk gets FiveRunner's function that takes an entry with where the
-- manifest defined it, and returns the function that runs a manifest.

local add = ...

local type, tostring, ipairs, select, rawget, rawset, rawequal, setmetatable =
    type, tostring, ipairs, select, rawget, rawset, rawequal, setmetatable
local getinfo, getmetatable = debug.getinfo, debug.getmetatable
local format = string.format

local AddMetaData

-- Checks argument `index` of AddMetaData as luaL_checkstring does: strings
-- pass, numbers turn into strings, and anything else fails the call.
local function checkString(value, index, count)
    local kind = type(value)
    if kind == 'string' then
        return value
    elseif kind == 'number' then
        return tostring(value)
    end
    local got = kind
    local metatable = getmetatable(value)
    if index > count then
        got = 'no value'
    elseif metatable ~= nil and type(rawget(metatable, '__name')) == 'string' then
        got = rawget(metatable, '__name')
    end
    -- AddMetaData named as its caller called it, as in Lua's argument errors.
    local name = getinfo(2, 'n').name
    if name == nil then
        name = rawequal(rawget(_G, 'AddMetaData'), AddMetaData) and 'AddMetaData' or '?'
    end
    error(format("bad argument #%d to '%s' (string expected, got %s)", index, name, got), 0)
end

function AddMetaData(...)
    local count = select('#', ...)
    local key, value = ...
    key = checkString(key, 1, count)
    value = checkString(value, 2, count)
    -- Like FiveM, it records where the caller of its caller is, which for
    -- the functions of names is the manifest.
    local where = getinfo(3, 'Sl')
    if where == nil then
        add(key, value)
    else
        add(key, value, where.source, where.short_src, where.currentline)
    end
end

rawset(_G, 'AddMetaData', AddMetaData)

return function(chunk)
    local addMetaData = AddMetaData

    setmetatable(_G, {
        __index = function(_, key)
            return function(value)
                local name = key

                if type(value) == 'table' then
                    if name:sub(-1) == 's' then
                        name = name:sub(1, -2)
                    end

                    for _, item in ipairs(value) do
                        addMetaData(name, item)
                    end
                else
                    addMetaData(key, value)
                end

                return function(extra)
                    addMetaData(name .. '_extra', json.encode(extra))
                end
            end
        end,
    })

    chunk()

    setmetatable(_G, nil)
end
