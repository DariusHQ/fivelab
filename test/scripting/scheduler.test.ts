import { describe, expect, it } from 'vitest'

import { createResource } from './helpers.ts'

describe('threads', () => {
  it('start CreateThread on the next tick', async () => {
    const res = await createResource()
    res.run(`CreateThread(function() print('thread') end)
print('main')`)
    expect(res.take()).toBe('main\n')
    res.tickAt(0)
    expect(res.take()).toBe('thread\n')
  })

  it('wait for game time', async () => {
    const res = await createResource()
    res.run(`CreateThread(function()
    print('start')
    Wait(100)
    print('waited')
end)`)
    res.tickAt(0)
    expect(res.take()).toBe('start\n')
    res.tickAt(99)
    expect(res.take()).toBe('')
    res.tickAt(100)
    expect(res.take()).toBe('waited\n')
  })

  it('resume after Wait(0) once per tick', async () => {
    const res = await createResource()
    res.run(`CreateThread(function()
    local n = 0
    while true do
        n = n + 1
        print(n)
        Wait(0)
    end
end)`)
    res.frames(3)
    expect(res.take()).toBe('1\n2\n3\n')
  })

  it('run CreateThreadNow at once and report whether it still runs', async () => {
    const res = await createResource()
    res.run(`print(Citizen.CreateThreadNow(function() print('now') end))
print(Citizen.CreateThreadNow(function() Wait(0) end))`)
    expect(res.take()).toBe('now\nfalse\ntrue\n')
  })

  it('run in order of wake time, then of scheduling', async () => {
    const res = await createResource()
    res.run(`SetTimeout(20, function() print('fourth') end)
CreateThread(function() print('first') end)
CreateThread(function() print('second') end)
SetTimeout(10, function() print('third') end)`)
    res.tickAt(100)
    expect(res.take()).toBe('first\nsecond\nthird\nfourth\n')
  })

  it('let script files wait at their top level', async () => {
    const res = await createResource()
    res.run(`print('loading')
Wait(10)
print('loaded')`)
    expect(res.take()).toBe('loading\n')
    res.tickAt(10)
    expect(res.take()).toBe('loaded\n')
  })

  it('are never resumed after yielding something other than a time', async () => {
    const res = await createResource()
    res.run(`CreateThread(function()
    coroutine.yield('later')
    print('resumed')
end)`)
    res.frames(5)
    expect(res.output).toBe('')
  })
})

describe('timeouts', () => {
  it('run after their delay', async () => {
    const res = await createResource()
    res.run(`SetTimeout(50, function() print('fired') end)`)
    res.tickAt(49)
    expect(res.take()).toBe('')
    res.tickAt(50)
    expect(res.take()).toBe('fired\n')
  })

  it('can only be cleared during the call that created them, as in FiveM', async () => {
    const res = await createResource()
    res.run(`local early = SetTimeout(10, function() print('early') end)
print(ClearTimeout(early))
late = SetTimeout(10, function() print('late') end)`)
    res.run(`print(ClearTimeout(late))`)
    res.tickAt(10)
    expect(res.take()).toBe('true\nfalse\nlate\n')
  })

  it('check their arguments like FiveM', async () => {
    const res = await createResource()
    res.run(`print(pcall(SetTimeout))
print(pcall(SetTimeout, 'soon', print))
print(pcall(ClearTimeout, 1.5))
print(pcall(ClearTimeout, {}))
print(ClearTimeout('2'), math.type(SetTimeout('10', function() end)))`)
    expect(res.take()).toBe(
      [
        "false\tbad argument #1 to 'SetTimeout' (number expected, got no value)",
        "false\tbad argument #1 to 'SetTimeout' (number expected, got string)",
        "false\tbad argument #1 to 'ClearTimeout' (number has no integer representation)",
        "false\tbad argument #1 to 'ClearTimeout' (number expected, got table)",
        'false\tinteger',
        '',
      ].join('\n'),
    )
  })

  it('name themselves in argument errors as the script calls them, as C functions do', async () => {
    const res = await createResource()
    res.run(`local later = Citizen.SetTimeout
print(pcall(function() later(nil) end))
print(pcall(function() Citizen.ClearTimeout(nil) end))
print(pcall(Citizen.SetTimeout, nil))`)
    expect(res.take()).toBe(
      [
        "false\t@test/client.lua:2: bad argument #1 to 'later' (number expected, got nil)",
        "false\t@test/client.lua:3: bad argument #1 to 'ClearTimeout' (number expected, got nil)",
        // pcall gives no name; the C function is found as the global SetTimeout.
        "false\tbad argument #1 to 'SetTimeout' (number expected, got nil)",
        '',
      ].join('\n'),
    )
  })
})

describe('script errors', () => {
  it('print SCRIPT ERROR and leave other threads running', async () => {
    const res = await createResource()
    res.run(`local function explode()
    error('boom')
end
CreateThread(function()
    explode()
end)
CreateThread(function()
    print('still running')
end)`)
    res.tickAt(0)
    expect(res.take()).toBe('^1SCRIPT ERROR: @test/client.lua:2: boom^7\nstill running\n')
  })

  it('stop only the file whose top level fails', async () => {
    const res = await createResource()
    expect(
      res.run(`print('before')
local missing = nil
missing.field = 1`),
    ).toBe(true)
    res.run(`print('next file')`, 'other.lua')
    expect(res.take()).toBe(
      "before\n^1SCRIPT ERROR: @test/client.lua:3: attempt to index a nil value (local 'missing')^7\n" +
        'next file\n',
    )
  })

  it('describe error values that are not strings', async () => {
    const res = await createResource()
    res.run(`CreateThreadNow = Citizen.CreateThreadNow
CreateThreadNow(function() error(setmetatable({}, {__tostring = function() return 'custom' end})) end)
CreateThreadNow(function() error(42) end)`)
    expect(res.take()).toBe(
      '^1SCRIPT ERROR: custom^7\n^1SCRIPT ERROR: error object is not a string^7\n',
    )
  })

  it('close the to-be-closed variables of failed threads', async () => {
    const res = await createResource()
    res.run(`Citizen.CreateThreadNow(function()
    local guard <close> = setmetatable({}, {__close = function() print('closed') end})
    error('boom', 0)
end)
Citizen.CreateThreadNow(function()
    local guard <close> = setmetatable({}, {__close = function() error('close failed', 0) end})
    error('boom', 0)
end)`)
    expect(res.take()).toBe(
      '^1SCRIPT ERROR: boom^7\nclosed\n' +
        '^1SCRIPT ERROR: boom^7\n' +
        '^1Error while closing to-be-closed variables: close failed^7\n',
    )
  })

  it('report files that do not compile', async () => {
    const res = await createResource()
    expect(res.run(`local = 1`, 'broken.lua')).toBe(false)
    expect(res.take()).toBe(
      "Error parsing script @test/broken.lua in resource test: @test/broken.lua:1: <name> expected near '='\n",
    )
  })
})

describe('Citizen.Await', () => {
  it('resumes the thread from within the call that resolves the promise', async () => {
    const res = await createResource()
    res.run(`pending = promise.new()
CreateThread(function()
    print('awaited', Citizen.Await(pending))
end)`)
    res.tickAt(0)
    res.run(`pending:resolve(42)
print('after resolve')`)
    expect(res.take()).toBe('awaited\t42\nafter resolve\n')
  })

  it('raises the rejection in the awaiting thread', async () => {
    const res = await createResource()
    res.run(`failing = promise.new()
CreateThread(function()
    print(pcall(Citizen.Await, failing))
end)`)
    res.tickAt(0)
    res.run(`failing:reject('nope')`)
    expect(res.take()).toBe('false\tnope\n')
  })

  it('returns the value of a settled promise without waiting', async () => {
    const res = await createResource()
    res.run(`local ready = promise.new()
ready:resolve('ready')
print(Citizen.Await(ready))`)
    expect(res.take()).toBe('ready\n')
  })
})

describe('globals', () => {
  it('match what FiveM defines', async () => {
    const res = await createResource()
    res.run(`print(Wait == Citizen.Wait, CreateThread == Citizen.CreateThread,
    SetTimeout == Citizen.SetTimeout, ClearTimeout == Citizen.ClearTimeout,
    type(promise.new), type(require), dofile, loadfile)`)
    expect(res.take()).toBe('true\ttrue\ttrue\ttrue\tfunction\tfunction\tnil\tnil\n')
  })

  it('print converts values with the current global tostring', async () => {
    const res = await createResource()
    res.run(`print(1, 1.5, nil, true, 'text')
local original = tostring
tostring = function(value) return '<' .. original(value) .. '>' end
print('x', 2)
tostring = function() return {} end
local ok, err = pcall(print, 1)
tostring = original
print(ok, err)`)
    expect(res.take()).toBe(
      "1\t1.5\tnil\ttrue\ttext\n<x>\t<2>\nfalse\t'tostring' must return a string to 'print'\n",
    )
  })

  it('print writes each piece as it converts it, as FiveM does', async () => {
    const res = await createResource()
    res.run(`local original = tostring
tostring = function(value) if value == 'bad' then return {} end return original(value) end
print(pcall(function() print('a', 'b', 'bad', 'c') end))
tostring = function() return 12 end
print('number')
tostring = original
print(debug.getinfo(print, 'S').what, 'nul\\0inside')`)
    expect(res.take()).toBe(
      "a\tbfalse\t@test/client.lua:3: 'tostring' must return a string to 'print'\n" +
        '12\n' +
        'C\tnul\0inside\n',
    )
  })

  it('Citizen.Trace writes text as it is, up to a NUL', async () => {
    const res = await createResource()
    res.run(`Citizen.Trace('no newline ')
Citizen.Trace(42)
Citizen.Trace('cut\\0off')
print(pcall(Citizen.Trace))
print(pcall(function() Citizen.Trace({}) end))`)
    expect(res.take()).toBe(
      'no newline 42cut' +
        // pcall gives no name, and Citizen.Trace is no global.
        "false\tbad argument #1 to '?' (string expected, got no value)\n" +
        "false\t@test/client.lua:5: bad argument #1 to 'Trace' (string expected, got table)\n",
    )
  })

  it('warn reports to the host', async () => {
    const res = await createResource()
    res.run(`warn('careful')`)
    expect(res.warnings).toEqual(['careful'])
  })
})
