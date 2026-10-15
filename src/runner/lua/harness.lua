--[[
    FiveRunner's test harness: the server script of the resource that runs
    the tests of a test file, each in a server of its own.

    It loads the test file that the runner names, as FiveM loads the server
    scripts of a resource, and collects the tests that the file adds with
    describe and it. Then it either tells the runner what they are, or runs
    the one that the runner asks for, in a thread of its own, between the
    beforeEach and afterEach hooks of the describes that the test is in,
    and tells the runner what failed.

    expect checks the values that tests give it, and fails the test with
    the first that is not as expected.
]]

local type, error, tostring = type, error, tostring
local pcall, xpcall, next, ipairs = pcall, xpcall, next, ipairs
local rawequal, rawget, rawlen = rawequal, rawget, rawlen
local setmetatable = setmetatable
local string_format, string_find, string_gsub = string.format, string.find, string.gsub
local table_concat, table_insert, table_sort = table.concat, table.insert, table.sort
local math_type, math_abs, math_huge = math.type, math.abs, math.huge
local debug_getinfo = debug.getinfo
local msgpack_pack = msgpack.pack

local call = FiverunnerCall
local resource = GetCurrentResourceName()

-- Asks the runner for something, with arguments that msgpack packs.
local function ask(method, args)
    return call(method, msgpack_pack(args or {}))
end

--[[ Errors ]]

local HARNESS = debug_getinfo(1, 'S').source

-- Raises an error at the first call outside the harness, as Lua's own
-- functions raise theirs where they were called.
local function raise(message)
    local level = 2
    while true do
        local info = debug_getinfo(level, 'S')
        if info == nil or info.source ~= HARNESS then
            break
        end
        level = level + 1
    end
    error(message, level)
end

-- Checks that argument `index` of the function `name` is of the type
-- `expected`, as Lua's own functions check theirs.
local function checkArgument(name, index, value, expected)
    if type(value) ~= expected then
        raise(string_format("bad argument #%d to '%s' (%s expected, got %s)", index, name, expected, type(value)))
    end
end

-- What expect fails tests with, whose message tostring gives.
local Failure = {}

function Failure.__tostring(failure)
    return failure.message
end

-- The message of an error, as tostring gives it.
local function messageOf(err)
    local ok, message = pcall(tostring, err)
    return ok and message or '(error object is not a string)'
end

--[[ Collecting tests ]]

-- The describes form a tree, whose root is the file, and each test is in one.
local root = { beforeEach = {}, afterEach = {} }
local suite = root
local tests = {}
local loading = true

-- Checks that a test, a describe or a hook is added as the test file loads.
local function checkLoading(name)
    if not loading then
        raise(string_format('%s adds to the tests of the file only as it loads', name))
    end
end

local function addSuite(name, mode, title, fn)
    checkArgument(name, 1, title, 'string')
    checkArgument(name, 2, fn, 'function')
    checkLoading(name)
    local parent = suite
    suite = { name = title, parent = parent, mode = mode, beforeEach = {}, afterEach = {} }
    fn()
    suite = parent
end

local function addTest(name, mode, title, fn, timeout)
    checkArgument(name, 1, title, 'string')
    checkArgument(name, 2, fn, 'function')
    if timeout ~= nil and not (type(timeout) == 'number' and timeout > 0 and timeout < math_huge) then
        local got = type(timeout) == 'number' and tostring(timeout) or type(timeout)
        raise(string_format("bad argument #3 to '%s' (milliseconds expected, got %s)", name, got))
    end
    checkLoading(name)
    tests[#tests + 1] = { name = title, suite = suite, mode = mode, fn = fn, timeout = timeout }
end

-- describe and it, which skip and only mark: tests that are skipped do not
-- run, and when a file marks some with only, its other tests do not either.
local function entry(name, add)
    return setmetatable({
        skip = function(...)
            add(name .. '.skip', 'skip', ...)
        end,
        only = function(...)
            add(name .. '.only', 'only', ...)
        end,
    }, {
        __call = function(_, ...)
            add(name, 'run', ...)
        end,
    })
end

describe = entry('describe', addSuite)
it = entry('it', addTest)
test = entry('test', addTest)

-- beforeEach and afterEach, which add hooks to the describe they are in.
local function hook(name)
    return function(fn)
        checkArgument(name, 1, fn, 'function')
        checkLoading(name)
        local hooks = suite[name]
        hooks[#hooks + 1] = fn
    end
end

beforeEach = hook('beforeEach')
afterEach = hook('afterEach')

-- The names of the describes that a test is in, and its own.
local function namesOf(test)
    local names = { test.name }
    local at = test.suite
    while at ~= root do
        table_insert(names, 1, at.name)
        at = at.parent
    end
    return names
end

-- How a test runs: skip if it or a describe it is in is skipped, and else
-- only if it or one of them is marked only.
local function modeOf(test)
    local skip, only = test.mode == 'skip', test.mode == 'only'
    local at = test.suite
    while at ~= root do
        skip = skip or at.mode == 'skip'
        only = only or at.mode == 'only'
        at = at.parent
    end
    return skip and 'skip' or only and 'only' or 'run'
end

--[[ Showing values ]]

local KEYWORDS = {}
for keyword in ('and break do else elseif end false for function goto if in local nil not or repeat return then true until while'):gmatch('%a+') do
    KEYWORDS[keyword] = true
end

-- Shows no more than this many entries of a table, and tables no deeper than this.
local SHOWN_ENTRIES = 20
local SHOWN_DEPTH = 3

-- Orders the keys of tables to show them: by type, then numbers by value
-- and the others as tostring gives them.
local function before(a, b)
    local ta, tb = type(a), type(b)
    if ta ~= tb then
        return ta < tb
    end
    if ta == 'number' then
        return a < b
    end
    return tostring(a) < tostring(b)
end

-- Shows a value as Lua code would write it, as far as it can.
local function show(value, depth)
    local kind = type(value)
    if kind == 'string' then
        return (string_gsub(string_format('%q', value), '\\\n', '\\n'))
    elseif kind ~= 'table' then
        return tostring(value)
    end
    depth = depth or 0
    if depth >= SHOWN_DEPTH then
        return next(value) == nil and '{}' or '{...}'
    end
    local length = rawlen(value)
    local keys = {}
    for key in next, value do
        if not (math_type(key) == 'integer' and key >= 1 and key <= length) then
            keys[#keys + 1] = key
        end
    end
    if length + #keys == 0 then
        return '{}'
    end
    table_sort(keys, before)
    local parts = {}
    for index = 1, length do
        if #parts == SHOWN_ENTRIES then
            break
        end
        parts[#parts + 1] = show(rawget(value, index), depth + 1)
    end
    for _, key in ipairs(keys) do
        if #parts == SHOWN_ENTRIES then
            break
        end
        local name = key
        if type(key) ~= 'string' or KEYWORDS[key] or not string_find(key, '^[%a_][%w_]*$') then
            name = '[' .. show(key, depth + 1) .. ']'
        end
        parts[#parts + 1] = name .. ' = ' .. show(rawget(value, key), depth + 1)
    end
    if length + #keys > SHOWN_ENTRIES then
        parts[#parts + 1] = '...'
    end
    return '{ ' .. table_concat(parts, ', ') .. ' }'
end

--[[ Comparing values ]]

-- Whether two values are the same, as toBe compares them, with NaN the
-- same as NaN.
local function same(a, b)
    return rawequal(a, b) or (a ~= a and b ~= b)
end

-- Whether two values are equal, as toEqual compares them: tables when
-- they have the same keys, with equal values, whatever their metatables,
-- and other values when they are the same.
local function equal(a, b, seen)
    if same(a, b) then
        return true
    end
    if type(a) ~= 'table' or type(b) ~= 'table' then
        return false
    end
    -- Tables that hold themselves are equal as far as they go.
    seen = seen or {}
    local compared = seen[a]
    if compared == nil then
        compared = {}
        seen[a] = compared
    elseif compared[b] then
        return true
    end
    compared[b] = true
    for key, value in next, a do
        if not equal(value, rawget(b, key), seen) then
            return false
        end
    end
    for key in next, b do
        if rawget(a, key) == nil then
            return false
        end
    end
    return true
end

--[[ Expectations ]]

-- The matchers of expect: each takes the value and the arguments of the
-- matcher, and returns whether the value matches, with what fails the test
-- if it does not, and what fails it if it does when negated with never.
local matchers = {}

function matchers.toBe(actual, expected)
    local hint = ''
    if type(actual) == 'table' and type(expected) == 'table' and equal(actual, expected) then
        hint = ', the same table: toEqual compares what tables hold'
    end
    return same(actual, expected),
        string_format('expected %s to be %s%s', show(actual), show(expected), hint),
        string_format('expected %s not to be %s', show(actual), show(expected))
end

function matchers.toEqual(actual, expected)
    return equal(actual, expected),
        string_format('expected %s to equal %s', show(actual), show(expected)),
        string_format('expected %s not to equal %s', show(actual), show(expected))
end

function matchers.toBeTruthy(actual)
    return actual ~= nil and actual ~= false,
        string_format('expected %s to be truthy', show(actual)),
        string_format('expected %s not to be truthy', show(actual))
end

function matchers.toBeFalsy(actual)
    return actual == nil or actual == false,
        string_format('expected %s to be falsy', show(actual)),
        string_format('expected %s not to be falsy', show(actual))
end

function matchers.toBeNil(actual)
    return actual == nil,
        string_format('expected %s to be nil', show(actual)),
        'expected the value not to be nil'
end

-- Adds a matcher that compares numbers.
local function comparison(name, phrase, compare)
    matchers[name] = function(actual, expected)
        if type(actual) ~= 'number' or type(expected) ~= 'number' then
            raise(string_format('%s compares numbers, not %s and %s', name, type(actual), type(expected)))
        end
        return compare(actual, expected),
            string_format('expected %s to be %s %s', show(actual), phrase, show(expected)),
            string_format('expected %s not to be %s %s', show(actual), phrase, show(expected))
    end
end

comparison('toBeGreaterThan', 'greater than', function(a, b)
    return a > b
end)
comparison('toBeGreaterThanOrEqual', 'greater than or equal to', function(a, b)
    return a >= b
end)
comparison('toBeLessThan', 'less than', function(a, b)
    return a < b
end)
comparison('toBeLessThanOrEqual', 'less than or equal to', function(a, b)
    return a <= b
end)

function matchers.toBeCloseTo(actual, expected, digits)
    if type(actual) ~= 'number' or type(expected) ~= 'number' then
        raise(string_format('toBeCloseTo compares numbers, not %s and %s', type(actual), type(expected)))
    end
    digits = digits == nil and 2 or digits
    if type(digits) ~= 'number' then
        raise(string_format('toBeCloseTo takes a number of digits, not %s', type(digits)))
    end
    local within = 10 ^ -digits / 2
    return actual == expected or math_abs(actual - expected) < within,
        string_format('expected %s to be close to %s, within %s', show(actual), show(expected), show(within)),
        string_format('expected %s not to be close to %s, within %s', show(actual), show(expected), show(within))
end

-- Whether a table has a value that `matches` takes as the item.
local function holds(t, item, matches)
    for _, value in next, t do
        if matches(value, item) then
            return true
        end
    end
    return false
end

function matchers.toContain(actual, item)
    local found
    if type(actual) == 'string' then
        if type(item) ~= 'string' then
            raise(string_format('toContain finds strings in strings, not %s', type(item)))
        end
        found = string_find(actual, item, 1, true) ~= nil
    elseif type(actual) == 'table' then
        found = holds(actual, item, same)
    else
        raise(string_format('toContain finds values in strings and tables, not in %s', type(actual)))
    end
    return found,
        string_format('expected %s to contain %s', show(actual), show(item)),
        string_format('expected %s not to contain %s', show(actual), show(item))
end

function matchers.toContainEqual(actual, item)
    if type(actual) ~= 'table' then
        raise(string_format('toContainEqual finds values in tables, not in %s', type(actual)))
    end
    return holds(actual, item, equal),
        string_format('expected %s to contain a value equal to %s', show(actual), show(item)),
        string_format('expected %s not to contain a value equal to %s', show(actual), show(item))
end

function matchers.toHaveLength(actual, length)
    if type(actual) ~= 'string' and type(actual) ~= 'table' then
        raise(string_format('toHaveLength measures strings and tables, not %s', type(actual)))
    end
    local actualLength = #actual
    return actualLength == length,
        string_format('expected %s to have length %s, not %s', show(actual), show(length), show(actualLength)),
        string_format('expected %s not to have length %s', show(actual), show(length))
end

function matchers.toMatch(actual, pattern)
    if type(actual) ~= 'string' or type(pattern) ~= 'string' then
        raise(string_format('toMatch matches strings with patterns, not %s with %s', type(actual), type(pattern)))
    end
    local ok, found = pcall(string_find, actual, pattern)
    if not ok then
        raise(string_format('toMatch takes Lua patterns: %s', found))
    end
    return found ~= nil,
        string_format('expected %s to match %s', show(actual), show(pattern)),
        string_format('expected %s not to match %s', show(actual), show(pattern))
end

function matchers.toThrow(actual, expected)
    if type(actual) ~= 'function' then
        raise(string_format('toThrow calls functions, not %s', type(actual)))
    end
    if expected ~= nil and type(expected) ~= 'string' then
        raise(string_format('toThrow finds strings in what functions throw, not %s', type(expected)))
    end
    local ok, err = pcall(actual)
    local with = expected == nil and '' or string_format(' an error with %s', show(expected))
    if ok then
        return false, string_format('expected the function to throw%s', with), ''
    end
    local message = messageOf(err)
    return expected == nil or string_find(message, expected, 1, true) ~= nil,
        string_format('expected the function to throw%s, but it threw %s', with, show(message)),
        string_format('expected the function not to throw%s, but it threw %s', with, show(message))
end

-- Runs a matcher on the value that expect took, and fails the test if the
-- value does not match, or if it does but `negated` says it should not.
local function check(expectation, name, matcher, actual, negated, ...)
    if rawequal((...), expectation) then
        raise(string_format('call %s with a dot, as in expect(value).%s(...), not with a colon', name, name))
    end
    local matches, message, negatedMessage = matcher(actual, ...)
    if matches == negated then
        error(setmetatable({ message = negated and negatedMessage or message }, Failure))
    end
end

-- Takes a value to check with the matchers that it gives, or that its
-- field never gives, which fail when the value matches.
function expect(actual)
    local expectation, negation = {}, {}
    for name, matcher in next, matchers do
        expectation[name] = function(...)
            check(expectation, name, matcher, actual, false, ...)
        end
        negation[name] = function(...)
            check(negation, name, matcher, actual, true, ...)
        end
    end
    expectation.never = negation
    return expectation
end

--[[ Running tests ]]

local target = ask('target')
local chunkName = string_format('@@%s/%s', resource, target.file)

-- Reports no more than this many lines that failures came through.
local REPORTED_FRAMES = 20

-- What failed, from what was raised: the message, with the lines of the
-- test file that the stack was at, innermost first.
local function failureOf(err)
    local frames = {}
    local level = 2
    while #frames < REPORTED_FRAMES do
        local info = debug_getinfo(level, 'Sln')
        if info == nil then
            break
        end
        if info.source == chunkName then
            frames[#frames + 1] = { line = info.currentline, name = info.name }
        end
        level = level + 1
    end
    return { message = messageOf(err), frames = frames }
end

-- Calls `fn`, and returns what failed, if anything did. Lua calls no
-- handler for errors of memory, and gives the error of the handler if
-- the handler fails.
local function attempt(fn)
    local failure
    local ok, err = xpcall(fn, function(raised)
        failure = failureOf(raised)
    end)
    if ok then
        return nil
    end
    return failure or { message = messageOf(err), frames = {} }
end

-- Runs a test with the hooks of the describes it is in: the beforeEach
-- hooks from the outermost describe in, the test if they did not fail, and
-- the afterEach hooks from the innermost describe out, in each the last
-- first. Returns what failed.
local function run(test)
    local failures = {}
    local function note(failure)
        failures[#failures + 1] = failure
        return failure == nil
    end
    local suites = {}
    local at = test.suite
    while at ~= nil do
        table_insert(suites, 1, at)
        at = at.parent
    end
    local ready = true
    for _, inner in ipairs(suites) do
        for _, fn in ipairs(inner.beforeEach) do
            ready = ready and note(attempt(fn))
        end
    end
    if ready then
        note(attempt(test.fn))
    end
    for index = #suites, 1, -1 do
        local hooks = suites[index].afterEach
        for hookIndex = #hooks, 1, -1 do
            note(attempt(hooks[hookIndex]))
        end
    end
    return failures
end

local loadFailure
local chunk, syntaxError = load(LoadResourceFile(resource, target.file), chunkName, 't')
if chunk == nil then
    loadFailure = { message = syntaxError, frames = {} }
else
    loadFailure = attempt(chunk)
end
loading = false

if target.test == nil then
    local collected = {}
    for index, entry in ipairs(tests) do
        collected[index] = { names = namesOf(entry), mode = modeOf(entry), timeout = entry.timeout }
    end
    ask('report', { tests = collected, failure = loadFailure })
else
    local entry = tests[target.test]
    if loadFailure ~= nil or entry == nil then
        local failure = loadFailure or { message = 'the test file has fewer tests than it had', frames = {} }
        ask('report', { failures = { failure } })
    else
        -- The scripts of the project start their threads before the test runs.
        CreateThread(function()
            local failures = run(entry)
            ask('report', { names = namesOf(entry), failures = failures })
        end)
    end
end
