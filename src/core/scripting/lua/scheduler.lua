--[[
    FiveRunner scheduler: Citizen threads, Wait, timeouts and Await, and the
    boundaries that stack traces walk between.

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

    An error in a thread prints SCRIPT ERROR and the stack trace of the
    runtimes that are running, like FiveM. The trace shows the frames of each
    call into a runtime between its boundaries, which the runtime's host
    keeps as FiveM's script host does: where the call started, the thread it
    resumed, and where it last left the runtime, as TriggerEvent does.

    Loaded by the runtime with its host functions and a private table that
    the other FiveRunner scripts share.
]]

local host, fiverunner = ...

local type, error, select, rawget, setmetatable = type, error, select, rawget, setmetatable
local pcall = pcall
local math_floor, math_ceil, math_mininteger = math.floor, math.ceil, math.mininteger
local string_format, string_sub = string.format, string.sub
local table_remove, table_pack, table_unpack = table.remove, table.pack, table.unpack
local coroutine_create = coroutine.create
local coroutine_resume = coroutine.resume
local coroutine_yield = coroutine.yield
local coroutine_status = coroutine.status
local coroutine_close = coroutine.close
local coroutine_running = coroutine.running
local debug_getinfo = debug.getinfo
local debug_getmetatable = debug.getmetatable

local clock = host.clock
local trace = host.trace
local checked = host.checked
local formatStackTrace = host.formatStackTrace
local clearBoundaryStart = host.clearBoundaryStart
local stackFrame = host.stackFrame

local G = _G
local Citizen = G.Citizen

local submitBoundaryStart = Citizen.SubmitBoundaryStart
local submitBoundaryEnd = Citizen.SubmitBoundaryEnd

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

-- Reports an error that ended a thread as FiveM does: SCRIPT ERROR, then the
-- stack trace of the runtimes that are running. Since April 2026 FiveM walks
-- no frames of a thread that failed, so the trace shows only the calls of
-- other runtimes that led to the thread. A stack trace that cannot be
-- formatted reads "(nil stack trace)", as in FiveM.
local function reportThreadError(co, err)
    local message = errorMessage(err)
    local formatted, stack = pcall(formatStackTrace)
    if not formatted then
        stack = '(nil stack trace)'
    end
    trace(string_format('^1SCRIPT ERROR: %s^7\n', message))
    if stack ~= '' then
        trace(stack)
    end
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

--[[ Boundaries ]]

-- Threads and calls out of the runtime take the ids of their boundaries from
-- one count, which starts at 1, as in FiveM.
local boundaryIdx = 1

local function nextBoundary()
    boundaryIdx = boundaryIdx + 1
    return boundaryIdx
end

-- The boundary each wrap function marks; see withBoundary.
local boundaryOf = setmetatable({}, { __mode = 'k' })

-- Calls fn(...) from a function named wrap, whose frame marks `boundary` for
-- stack traces, as FiveM's wrap functions do, and returns the results packed.
local function withBoundary(boundary, fn, ...)
    local function wrap(...)
        local v = table_pack(fn(...))
        return table_unpack(v)
    end
    boundaryOf[wrap] = boundary
    return table_pack(wrap(...))
end

-- Runs fn(...) as a call out of the runtime, as FiveM's runWithBoundaryEnd
-- does: the stack traces of the runtimes it calls into show the frames of
-- this one from where it called fn.
local function runWithBoundaryEnd(fn, ...)
    local boundary = nextBoundary()
    submitBoundaryEnd(boundary)
    local v = withBoundary(boundary, fn, ...)
    submitBoundaryEnd(boundary)
    return table_unpack(v)
end

--[[ Running threads ]]

local lastId = 0

-- A thread runs its function from the wrap frame of its boundary, which
-- calls it through an upvalue named fn, so that stack traces and errors name
-- it as FiveM's do.
local function newThread(fn)
    lastId = lastId + 1
    local boundary = nextBoundary()
    return {
        id = lastId,
        boundary = boundary,
        co = coroutine_create(function(...)
            withBoundary(boundary, fn, ...)
        end),
    }
end

-- The threads being resumed, the innermost last.
local runningThreads = {}

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

-- Resumes a thread as FiveM's Lua runtime does, marking it as where the
-- current call into the runtime starts until it yields or ends.
function run(thread)
    local co = thread.co
    if coroutine_status(co) == 'dead' then
        return false
    end
    runningThreads[#runningThreads + 1] = co
    submitBoundaryStart(thread.boundary)
    local yielded = resumed(thread, coroutine_resume(co))
    clearBoundaryStart()
    runningThreads[#runningThreads] = nil
    return yielded
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

--[[ Stack traces ]]

local mainThread = coroutine_running()

-- Whether stack traces leave out the frames of a chunk, as FiveM leaves out
-- those of C functions and of its own scripts, which FiveRunner's stand for.
local CITIZEN_SCRIPTS, OWN_SCRIPTS = '@citizen:/', '@fiverunner:/'
local function isHidden(source)
    return string_sub(source, 1, 1) == '='
        or string_sub(source, 1, #CITIZEN_SCRIPTS) == CITIZEN_SCRIPTS
        or string_sub(source, 1, #OWN_SCRIPTS) == OWN_SCRIPTS
end

-- Walks the stack of the innermost thread being resumed, as FiveM's stack
-- trace routine does, and gives the host each frame from the wrap frame of
-- boundary `from` (from the top for nil) to that of boundary `to` (to the
-- bottom for nil). A thread that failed is not walked: FiveM walks the main
-- thread of the runtime instead, where resource scripts seldom run.
function fiverunner.walkStack(from, to)
    local thread = runningThreads[#runningThreads]
    if thread == nil or coroutine_status(thread) == 'dead' then
        thread = mainThread
    end
    local skip = from ~= nil
    local level = 0
    while true do
        local info = debug_getinfo(thread, level, 'nlfS')
        if info == nil then
            break
        end
        local boundary = boundaryOf[info.func]
        if boundary ~= nil then
            if boundary == from then
                skip = false
            end
            if boundary == to then
                break
            end
        end
        if not skip and not isHidden(info.source) then
            stackFrame(info.name or '[global chunk]', string_sub(info.source, 2), info.currentline)
        end
        level = level + 1
    end
end

--[[ Entry points for the runtime ]]

-- Threads that were due when the current tick began, in the order they were
-- queued.
local due = {}

-- Takes the threads that are due out of the queue. A process does this for
-- all of its runtimes before it resumes threads in any of them, so that, as
-- in FiveM, a thread queued during a tick waits for the next one.
function fiverunner.collect()
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
function fiverunner.resume()
    local batch = due
    due = {}
    for i = 1, #batch do
        run(batch[i])
    end
    flush()
end

-- Runs a script file of the resource in a new thread, as FiveM does: it may
-- wait, and an error stops only that file.
function fiverunner.runFile(chunk)
    createThreadNow(chunk)
    flush()
end

fiverunner.createThreadNow = createThreadNow
fiverunner.runWithBoundaryEnd = runWithBoundaryEnd
fiverunner.flush = flush
fiverunner.errorMessage = errorMessage
