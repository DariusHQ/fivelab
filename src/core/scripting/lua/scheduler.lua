--[[
    FiveLab scheduler: Citizen threads, Wait, timeouts and Await.

    Threads are coroutines that the runtime resumes on its ticks, as in FiveM:

    - Citizen.CreateThread and Citizen.SetTimeout start a thread on a later
      tick. A thread created during one call into the runtime is queued when
      that call returns; until then Citizen.ClearTimeout can cancel it, and
      afterwards it cannot (FiveM behaves the same way).
    - Citizen.CreateThreadNow runs the thread at once, until it first waits.
    - Citizen.Wait(ms) suspends the current thread for at least `ms`
      milliseconds of game time; Wait(0) or Wait() until the next tick. A
      thread that yields anything but a number or nil is never resumed.
    - Citizen.Await(promise) suspends the current thread until the promise
      settles, and resumes it from within the call that settles it.

    An error in a thread prints SCRIPT ERROR, like FiveM.

    Loaded by the runtime with its host functions and a private table that
    the other FiveLab scripts share.
]]

local host, fivelab = ...

local type, error, select, rawget = type, error, select, rawget
local pcall = pcall
local math_floor, math_huge = math.floor, math.huge
local string_format = string.format
local table_remove = table.remove
local coroutine_create = coroutine.create
local coroutine_resume = coroutine.resume
local coroutine_yield = coroutine.yield
local coroutine_status = coroutine.status
local coroutine_close = coroutine.close
local debug_getmetatable = debug.getmetatable

local gameTimer = host.gameTimer
local trace = host.trace
local checked = host.checked

local G = _G
local Citizen = G.Citizen

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
    local closed, closeError = coroutine_close(co)
    if not closed and errorMessage(closeError) ~= errorMessage(err) then
        trace(string_format('^1Error while closing to-be-closed variables: %s^7\n', errorMessage(closeError)))
    end
end

--[[ The queue of waiting threads ]]

-- A binary heap of threads ordered by wake time, then by the order they were
-- scheduled in.
local heap, size = {}, 0
local order = 0

local function before(a, b)
    return a.time < b.time or (a.time == b.time and a.order < b.order)
end

local function push(thread, time)
    order = order + 1
    thread.time, thread.order = time, order
    size = size + 1
    local i = size
    while i > 1 do
        local parent = i // 2
        if not before(thread, heap[parent]) then
            break
        end
        heap[i] = heap[parent]
        i = parent
    end
    heap[i] = thread
end

local function pop()
    local top, last = heap[1], heap[size]
    heap[size] = nil
    size = size - 1
    if size > 0 then
        local i = 1
        while true do
            local child = i * 2
            if child > size then
                break
            end
            if child < size and before(heap[child + 1], heap[child]) then
                child = child + 1
            end
            if not before(heap[child], last) then
                break
            end
            heap[i] = heap[child]
            i = child
        end
        heap[i] = last
    end
    return top
end

-- Threads created during the current call into the runtime, with the delay
-- before their first run.
local pending = {}

local function flush()
    local count = #pending
    if count == 0 then
        return
    end
    local now = gameTimer()
    for i = 1, count do
        local thread = pending[i]
        pending[i] = nil
        push(thread, now + thread.delay)
    end
end

-- Milliseconds to wait for a number of milliseconds, as FiveM truncates it.
local function delayOf(ms)
    if ms ~= ms or ms <= 0 then
        return 0
    elseif ms == math_huge then
        return math_huge
    end
    return math_floor(ms)
end

--[[ Running threads ]]

-- What Citizen.Await yields to ask for a function that resumes its thread.
local AWAIT = {}

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
-- it to the promise and yields again, without a time.
local function awaiting(thread)
    local co = thread.co
    local ok, err = coroutine_resume(co, function()
        run(thread)
    end)
    if not ok then
        reportThreadError(co, err)
        return false
    end
    return coroutine_status(co) == 'suspended'
end

-- Handles the outcome of resuming a thread. Returns whether it is still alive.
local function resumed(thread, ok, ...)
    local co = thread.co
    if not ok then
        reportThreadError(co, (...))
        return false
    end
    if coroutine_status(co) == 'dead' then
        return false
    end
    local count = select('#', ...)
    local wait = nil
    if count > 0 then
        wait = select(count, ...)
    end
    if wait == AWAIT then
        return awaiting(thread)
    end
    local kind = type(wait)
    if kind == 'number' then
        push(thread, gameTimer() + delayOf(wait))
    elseif kind == 'nil' then
        push(thread, gameTimer())
    end
    return true
end

function run(thread, ...)
    if coroutine_status(thread.co) == 'dead' then
        return false
    end
    return resumed(thread, coroutine_resume(thread.co, ...))
end

local function createThreadNow(fn)
    return run(newThread(fn))
end

--[[ Citizen API ]]

function Citizen.CreateThread(fn)
    local thread = newThread(fn)
    thread.delay = 0
    pending[#pending + 1] = thread
    return thread.id
end

function Citizen.CreateThreadNow(fn)
    return createThreadNow(fn)
end

-- SetTimeout and ClearTimeout check their arguments as FiveM's C functions do.
Citizen.SetTimeout = checked('n.', function(ms, fn)
    local thread = newThread(fn)
    thread.delay = delayOf(ms)
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

-- Resumes the threads that are due. Threads they schedule, even for no time,
-- wait for the next tick.
function fivelab.tick()
    flush()
    local now = gameTimer()
    if size == 0 or heap[1].time > now then
        return
    end
    local due, count = {}, 0
    while size > 0 and heap[1].time <= now do
        count = count + 1
        due[count] = pop()
    end
    for i = 1, count do
        run(due[i])
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
