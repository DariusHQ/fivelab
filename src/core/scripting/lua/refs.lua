--[[
    FiveLab function references: Citizen.GetFunctionReference, the routines
    the runtime runs for the references of its functions, and the proxies
    that stand for the functions of other runtimes.

    A reference names a function of a runtime, so that other runtimes can
    call it. Citizen.CanonicalizeRef formats it from the reference's index,
    as "resource:instance:index", which FiveM's script host looks it up by.
    Indices count up from 0 in each runtime, as in FiveM.

    Each reference counts the holders that duplicated it, from 0. Deleting
    it takes one away, and once none is left, or when it had none, the
    runtime forgets the function.

    msgpack packs functions as their references, which unpack as proxies:
    tables that hold the reference until they are collected, as in FiveM.

    Loaded by the runtime after the events script, with the table the
    FiveLab scripts share.
]]

local fivelab = ...

local type, error, rawget, setmetatable = type, error, rawget, setmetatable
local msgpack = msgpack

local Citizen = Citizen

-- The functions that references name, by index, with their holders.
local references = {}
local nextIndex = 0

local function reference(fn)
    local index = nextIndex
    references[index] = { fn = fn, holders = 0 }
    nextIndex = index + 1
    -- FiveM looks the function up in the Citizen table when it runs.
    return Citizen.CanonicalizeRef(index)
end

-- References a function, or a reference of another runtime, which FiveM
-- references through a function that calls it. Other values have none.
function Citizen.GetFunctionReference(fn)
    if type(fn) == 'function' then
        return reference(fn)
    elseif type(fn) == 'table' and rawget(fn, '__cfx_functionReference') then
        return reference(function(...)
            return fn(...)
        end)
    end
    return nil
end

--[[ Proxies ]]

-- msgpack packs functions in extension 10. FiveM's C++ code packs its own
-- functions in extension 11, which unpacks the same.
local EXT_FUNCREF, EXT_LOCALFUNCREF = 10, 11

msgpack.extend_clear(EXT_FUNCREF, EXT_LOCALFUNCREF)

local proxy

-- Packs a function, or a proxy, as a reference to it.
local function packReference(value, ext)
    local ref = Citizen.GetFunctionReference(value)
    if ref then
        return ref
    end
    error(('Unknown funcref type: %d %s'):format(ext, type(value)), 2)
end

-- Unpacks a reference as a proxy, which holds it.
local function unpackReference(ref)
    DuplicateFunctionReference(ref)
    return setmetatable({ __cfx_functionReference = ref }, proxy)
end

proxy = msgpack.extend({
    __ext = EXT_FUNCREF,
    __pack = packReference,
    __unpack = unpackReference,
    __gc = function(self)
        DeleteFunctionReference(rawget(self, '__cfx_functionReference'))
    end,
    __index = function()
        error('Cannot index a funcref', 2)
    end,
    __newindex = function()
        error('Cannot set indexes on a funcref', 2)
    end,
})

msgpack.extend({
    __ext = EXT_LOCALFUNCREF,
    __pack = packReference,
    __unpack = unpackReference,
})

msgpack.settype('function', EXT_FUNCREF)

--[[ Routines the runtime runs ]]

-- Counts another holder of a reference, and returns the index it keeps, or
-- -1 for a reference the runtime does not have.
function fivelab.duplicateRef(index)
    local entry = references[index]
    if not entry then
        return -1
    end
    entry.holders = entry.holders + 1
    return index
end

-- Takes a holder of a reference away, forgetting it once none is left.
function fivelab.deleteRef(index)
    local entry = references[index]
    if not entry then
        return
    end
    entry.holders = entry.holders - 1
    if entry.holders <= 0 then
        references[index] = nil
    end
end
