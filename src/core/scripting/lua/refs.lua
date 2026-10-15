--[[
    FiveRunner function references: Citizen.GetFunctionReference, the routines
    the runtime runs for the references of its functions, and the proxies
    that call the functions of other runtimes.

    A reference names a function of a runtime, so that other runtimes can
    call it. Citizen.CanonicalizeRef formats it from the reference's index,
    as "resource:instance:index", which FiveM's script host looks it up by.
    Indices count up from 0 in each runtime, as in FiveM.

    Each reference counts the holders that duplicated it, from 0. Deleting
    it takes one away, and once none is left, or when it had none, the
    runtime forgets the function.

    msgpack packs functions as their references, which unpack as proxies:
    tables that call the function through Citizen.InvokeFunctionReference,
    and hold the reference until they are collected, as in FiveM.

    Loaded by the runtime after the events script, with its host functions
    and the table the FiveRunner scripts share.
]]

local host, fiverunner = ...

local type, error, rawget, setmetatable = type, error, rawget, setmetatable
local debug_getinfo = debug.getinfo
local coroutine_running = coroutine.running
local msgpack = msgpack

-- Argument errors name a function by the variable it is called through, so
-- the functions whose arguments can be wrong have the names FiveM gives them.
local table_unpack = table.unpack
local msgpack_pack = msgpack.pack
local msgpack_unpack = msgpack.unpack
local msgpack_pack_args = msgpack.pack_args
local Citizen_InvokeFunctionReference = Citizen.InvokeFunctionReference

local Citizen = Citizen
local formatStackTrace = host.formatStackTrace
local runWithBoundaryEnd = fiverunner.runWithBoundaryEnd

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

-- Calls the function of a proxy in its runtime, as a call out of this one.
local function callProxy(self, ...)
    local ref = rawget(self, '__cfx_functionReference')
    local args = msgpack_pack_args(...)
    local packed = runWithBoundaryEnd(function()
        return Citizen_InvokeFunctionReference(ref, args)
    end)
    local results = msgpack_unpack(packed)
    -- A function that waited gives a function to call back with its results
    -- once it returns, which the current thread awaits.
    if results and type(results[1]) == 'table' and rawget(results[1], '__cfx_async_retval')
        and coroutine_running() then
        local p = promise.new()
        results[1].__cfx_async_retval(function(returned, err)
            if returned then
                p:resolve(returned)
            elseif err then
                p:reject(err)
            end
        end)
        return table_unpack(Citizen.Await(p))
    end
    -- The function failed, or the reference names none.
    if not results then
        error()
    end
    return table_unpack(results)
end

proxy = msgpack.extend({
    __ext = EXT_FUNCREF,
    __pack = packReference,
    __unpack = unpackReference,
    __call = callProxy,
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

-- How the call ref routine reports an error of the function it calls, as
-- FiveM's does: SCRIPT ERROR, with the stack trace of the runtimes that are
-- running.
local function describeError(err)
    return string.format('^1SCRIPT ERROR: %s^7\n%s', err or '', formatStackTrace())
end

-- Calls the function of a reference with the arguments that msgpack packed,
-- and returns its results packed, as FiveM's call ref routine does. The
-- function runs in a thread of its own: if it fails, the results are nil,
-- and if it waits, a function that takes a callback, which the thread calls
-- with the results, or false and the error, once the function returns.
function fiverunner.callRef(index, args)
    local entry = references[index]
    if not entry then
        Citizen.Trace('Invalid ref call attempt: ' .. index .. '\n')
        return msgpack_pack(nil)
    end
    local ref = entry.fn
    local results, failure = false, nil
    local callback = {}
    -- FiveM names the thread after the function, for its profiler.
    local info = debug_getinfo(ref)
    local name = ('ref call [%s[%d..%d]]'):format(info.short_src, info.linedefined, info.lastlinedefined)
    local waited = Citizen.CreateThreadNow(function()
        local ok, err = xpcall(function()
            -- Called through an upvalue named ref, which stack traces name it by.
            results = { ref(table_unpack(msgpack_unpack(args))) }
        end, describeError)
        if not ok then
            failure = err or ''
        end
        if callback.fn then
            callback.fn(results, failure)
        elseif failure then
            Citizen.Trace(failure)
        end
    end, name)
    if waited then
        return msgpack_pack({ {
            __cfx_async_retval = function(fn)
                callback.fn = fn
            end,
        } })
    elseif failure then
        return msgpack_pack(nil)
    end
    return msgpack_pack(results)
end

-- Counts another holder of a reference, and returns the index it keeps, or
-- -1 for a reference the runtime does not have.
function fiverunner.duplicateRef(index)
    local entry = references[index]
    if not entry then
        return -1
    end
    entry.holders = entry.holders + 1
    return index
end

-- Takes a holder of a reference away, forgetting it once none is left.
function fiverunner.deleteRef(index)
    local entry = references[index]
    if not entry then
        return
    end
    entry.holders = entry.holders - 1
    if entry.holders <= 0 then
        references[index] = nil
    end
end
