--[[
    FiveLab scheduler: Citizen threads, Wait, timeouts and Await.

    Threads are coroutines that the runtime resumes on its ticks, the way
    FiveM's scripting host runs its "bookmarks":

    - Citizen.CreateThread and Citizen.SetTimeout queue a new thread for a
      later tick. Threads created during a call into the runtime are queued
      when that call returns; until then Citizen.ClearTimeout can cancel
      them, and afterwards it cannot (FiveM behaves the same way).
    - Citizen.CreateThreadNow runs the thread at once, until it first waits.
    - Citizen.Wait(ms) suspends the current thread for at least `ms`
      milliseconds; Wait(0) or Wait() until the next tick. A thread that
      yields anything but a number or nil, or yields nothing, is never
      resumed.
    - Citizen.Await(promise) suspends the current thread until the promise
      settles, and resumes it from within the call that settles it.

    A tick resumes the threads that were due when it began, in the order they
    were queued, whatever their deadlines. Deadlines are microseconds on the
    host's clock, and delays are converted as FiveM's C code converts them,
    overflows included.

    An error in a thread prints SCRIPT ERROR, like FiveM.

    Loaded by the runtime with its host functions and a private table that
    the other FiveLab scripts share.
]]

local host, fivelab = ...

local type, error, select, rawget = type, error, select, rawget
local pcall = pcall
local math_floor, math_ceil, math_mininteger = math.floor, math.ceil, math.mininteger
local string_format = string.format
local table_remove = table.remove
local coroutine_create = coroutine.create
local coroutine_resume = coroutine.resume
local coroutine_yield = coroutine.yield
local coroutine_status = coroutine.status
local coroutine_close = coroutine.close
local debug_getmetatable = debug.getmetatable

local clock = host.clock
local trace = host.trace
local checked = host.checked

local G = _G
local Citizen = G.Citizen

-- What Citizen.Await yields to ask for a function that resumes its thread.
-- FiveM's scheduler takes it out of the Citizen table too.
local AWAIT = Citizen.AwaitSentinel()
Citizen.AwaitSentinel = nil

--[[ Errors ]]

-- Describes a thrown value like FiveM does: strings as they are, other values
-- through __tostring.
local function errorMessage(err)
    if type(err) == 'string' then
        return err
    end
    local mt = debug_getmetatable(err)
    local tostringMeta = mt and rawget(mt, '__tostring')
    if tostringMeta then
        local ok, message = pcall(tostringMeta, err)
        if ok and type(message) == 'string' then
            return message
        end
    end
    return 'error object is not a string'
end

-- Reports an error that ended a thread. FiveM follows SCRIPT ERROR with a
-- stack trace, but since April 2026 it walks no frames of a thread that
-- failed, so the trace of an error in the resource's own threads is empty.
local function reportThreadError(co, err)
    trace(string_format('^1SCRIPT ERROR: %s^7\n', errorMessage(err)))
    -- A thread that is still running failed to resume, and has nothing to close.
    if coroutine_status(co) ~= 'dead' then
        return
    end
    local closed, closeError = coroutine_close(co)
    if not closed and errorMessage(closeError) ~= errorMessage(err) then
        trace(string_format('^1Error while closing to-be-closed variables: %s^7\n', errorMessage(closeError)))
    end
end

--[[ Delays, as FiveM's C code converts them ]]

-- The (int64_t) cast that FiveM's Wait applies to the number a thread
-- yields, as x86-64 computes it: integers become floats first, fractions are
-- cut off, and NaN and values out of range give INT64_MIN.
local function toInt64(n)
    n = n + 0.0
    if n ~= n or n >= 0x1p63 or n < -0x1p63 then
        return math_mininteger
    elseif n >= 0 then
        return math_floor(n)
    end
    return math_ceil(n)
end

-- The (int) cast that FiveM's SetTimeout applies to its delay, which
-- luaL_checknumber made a float.
local function toInt32(n)
    if n ~= n or n >= 0x1p31 or n < -0x1p31 then
        return -0x80000000
    elseif n >= 0 then
        return math_floor(n)
    end
    return math_ceil(n)
end

-- The deadline FiveM's scripting host gives a thread scheduled with `at`: a
-- negative `at` is minus a delay in milliseconds, and any other value a time
-- on the clock itself, in microseconds, which has long passed for the values
-- scripts end up with. The arithmetic wraps around, as it does in FiveM.
local function deadlineOf(at)
    if at < 0 then
        return clock() + -at * 1000
    end
    return at
end

--[[ The queue of waiting threads ]]

-- Threads waiting for their deadline, in the order they were queued.
local queue = {}

local function enqueue(thread, at)
    thread.deadline = deadlineOf(at)
    queue[#queue + 1] = thread
end

-- Threads created during the current call into the runtime, with the `at`
-- FiveM schedules them with: minus their delay.
local pending = {}

local function flush()
    for i = 1, #pending do
        local thread = pending[i]
        pending[i] = nil
        enqueue(thread, thread.at)
    end
end

--[[ Running threads ]]

local lastId = 0

-- Calls the thread function through a local named fn, so stack traces name
-- its frame as FiveM's do.
local function newThread(fn)
    lastId = lastId + 1
    return {
        id = lastId,
        co = coroutine_create(function(...)
            fn(...)
        end),
    }
end

local run

-- Gives an awaiting thread the function that resumes it. Citizen.Await hands
-- it to the promise and yields nothing, so the thread waits until the promise
-- calls it. Like FiveM, this reports no error from that part of Await.
local function awaiting(thread)
    local co = thread.co
    local ok = coroutine_resume(co, function()
        run(thread)
    end)
    return ok and coroutine_status(co) == 'suspended'
end

-- Handles the outcome of resuming a thread, as FiveM does. Returns whether
-- the thread yielded.
local function resumed(thread, ok, ...)
    local co = thread.co
    if not ok then
        reportThreadError(co, (...))
        return false
    end
    if coroutine_status(co) == 'dead' then
        return false
    end
    -- FiveM looks at the top of the thread's stack, which holds the last value
    -- the thread yielded, or when it yielded nothing, the function that
    -- yielded: such a thread is never resumed.
    local count = select('#', ...)
    if count == 0 then
        return true
    end
    local wait = select(count, ...)
    if wait == AWAIT then
        return awaiting(thread)
    end
    local kind = type(wait)
    if kind == 'number' then
        enqueue(thread, -toInt64(wait))
    elseif kind == 'nil' then
        enqueue(thread, 0)
    end
    return true
end

function run(thread)
    if coroutine_status(thread.co) == 'dead' then
        return false
    end
    return resumed(thread, coroutine_resume(thread.co))
end

local function createThreadNow(fn)
    return run(newThread(fn))
end

--[[ Citizen API ]]

function Citizen.CreateThread(fn)
    local thread = newThread(fn)
    thread.at = 0
    pending[#pending + 1] = thread
    return thread.id
end

function Citizen.CreateThreadNow(fn)
    return createThreadNow(fn)
end

-- SetTimeout and ClearTimeout check their arguments as FiveM's C functions do.
Citizen.SetTimeout = checked('n.', function(ms, fn)
    local thread = newThread(fn)
    local delay = toInt32(ms)
    -- FiveM negates the delay as an int, which leaves INT_MIN as it is.
    thread.at = delay == -0x80000000 and delay or -delay
    pending[#pending + 1] = thread
    return thread.id
end)

Citizen.ClearTimeout = checked('i', function(id)
    for i = 1, #pending do
        if pending[i].id == id then
            table_remove(pending, i)
            return true
        end
    end
    return false
end)

function Citizen.Wait(ms)
    coroutine_yield(ms)
end

function Citizen.Await(promise)
    if promise.state == 0 then
        local resume = coroutine_yield(AWAIT)
        promise:next(resume, resume)
        coroutine_yield()
    end
    if promise.state == 2 or promise.state == 4 then
        error(promise.value, 2)
    end
    return promise.value
end

-- Citizen.Trace and print are FiveM's, written in C: print converts its
-- arguments with the global tostring and writes each piece as it goes.
Citizen.Trace = host.Trace
G.print = host.print

-- Root-level aliases, as FiveM defines them.
G.Wait = Citizen.Wait
G.CreateThread = Citizen.CreateThread
G.SetTimeout = Citizen.SetTimeout
G.ClearTimeout = Citizen.ClearTimeout

--[[ Entry points for the runtime ]]

-- Threads that were due when the current tick began, in the order they were
-- queued.
local due = {}

-- Takes the threads that are due out of the queue. A process does this for
-- all of its runtimes before it resumes threads in any of them, so that, as
-- in FiveM, a thread queued during a tick waits for the next one.
function fivelab.collect()
    local now = clock()
    local count, kept = #queue, 0
    for i = 1, count do
        local thread = queue[i]
        if thread.deadline <= now then
            due[#due + 1] = thread
        else
            kept = kept + 1
            queue[kept] = thread
        end
    end
    for i = kept + 1, count do
        queue[i] = nil
    end
end

-- Resumes the threads collected as due, then queues the threads they created.
function fivelab.resume()
    local batch = due
    due = {}
    for i = 1, #batch do
        run(batch[i])
    end
    flush()
end

-- Runs a script file of the resource in a new thread, as FiveM does: it may
-- wait, and an error stops only that file.
function fivelab.runFile(chunk)
    createThreadNow(chunk)
    flush()
end

fivelab.createThreadNow = createThreadNow
fivelab.flush = flush
fivelab.errorMessage = errorMessage
