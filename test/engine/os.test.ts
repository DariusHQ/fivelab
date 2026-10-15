import { describe, expect, it } from 'vitest'

import { addFile } from '../../src/core/engine/files.ts'
import type { TimeZone } from '../../src/core/scripting/time.ts'
import { createProcess, runCommand, startResource, type ProcessOptions } from './helpers.ts'

/** A time zone an hour ahead of UTC, and two in DST, from April through September of UTC. */
const ZONE: TimeZone = {
  offset: (time) => {
    const month = new Date(time).getUTCMonth()
    return month >= 3 && month <= 8 ? 120 : 60
  },
  standardOffset: 60,
  dstBias: 60,
  names: ['Test Standard Time', 'Test Daylight Time'],
}

/** 2023-11-14 22:13:20 UTC, a Tuesday. */
const TIME = 1_700_000_000

/** A server whose wall clock says TIME, half a second into it, in ZONE. */
function server(options: ProcessOptions = {}) {
  return createProcess({ wallClock: () => TIME * 1000 + 500, timeZone: ZONE, ...options })
}

/** What a resource prints as it runs `lua`. */
async function run(lua: string, options: ProcessOptions = {}): Promise<string[]> {
  return startResource(await server(options), 'a', { 'main.lua': lua }).map((line) =>
    line.replace(/^\[script:a\] /, ''),
  )
}

describe('The os library of servers', () => {
  it('is FiveM own, loaded as a library, and clients have none', async () => {
    const client = await createProcess({ side: 'client' })
    expect([
      await run(`local names = {}
for name in pairs(os) do names[#names + 1] = name end
table.sort(names)
print(table.concat(names, ' '))
print(require('os') == os, os.exit)`),
      startResource(client, 'a', { 'main.lua': 'print(os)' }),
    ]).toEqual([
      [
        'clock createdir date deltatime difftime execute getenv microtime nanotime rdtsc rdtscp remove rename setlocale time tmpname',
        'true\tnil',
      ],
      ['[script:a] nil'],
    ])
  })

  it('tells the time by the wall clock, in whole seconds, and dates it in the local time zone', async () => {
    expect(await run(`print(os.time(), math.type(os.time()), os.date())`)).toEqual([
      `${TIME}\tinteger\t11/14/23 23:13:20`,
    ])
  })

  it('formats dates as MSVC does in the C locale', async () => {
    const specs = 'aAbBcdHIjmMpSUwWxXyYzZ%'
    const lua = [...specs, '#c', '#x'].map(
      (spec) => `print('${spec}', os.date('%${spec}', ${TIME}))`,
    )
    expect(await run(lua.join('\n'))).toEqual([
      'a\tTue',
      'A\tTuesday',
      'b\tNov',
      'B\tNovember',
      'c\t11/14/23 23:13:20',
      'd\t14',
      'H\t23',
      'I\t11',
      'j\t318',
      'm\t11',
      'M\t13',
      'p\tPM',
      'S\t20',
      'U\t46',
      'w\t2',
      'W\t46',
      'x\t11/14/23',
      'X\t23:13:20',
      'y\t23',
      'Y\t2023',
      'z\t+0100',
      'Z\tTest Standard Time',
      '%\t%',
      '#c\tTuesday, November 14, 2023 23:13:20',
      '#x\tTuesday, November 14, 2023',
    ])
  })

  it('leave the zeros out of numbers with #', async () => {
    // 2024-01-05 03:04:05 local time, a Friday.
    const time = 1_704_420_245
    const specs = ['d', 'H', 'I', 'j', 'm', 'M', 'S', 'U', 'W', 'w', 'y', 'Y']
    const lua = specs.map((spec) => `print(os.date('%${spec} %#${spec}', ${time}))`)
    lua.push(`print(os.date('%p %#x', ${time}))`)
    expect(await run(lua.join('\n'))).toEqual([
      '05 5',
      '03 3',
      '03 3',
      '005 5',
      '01 1',
      '04 4',
      '05 5',
      '00 0',
      '01 1',
      '5 5',
      '24 24',
      '2024 2024',
      'AM Friday, January 05, 2024',
    ])
  })

  it('say DST and its offset and name, and those of standard time for UTC, as MSVC does', async () => {
    // 2023-07-01 12:00:00 UTC.
    const summer = 1_688_212_800
    expect(
      await run(`print(os.date('%H %z %Z', ${summer}))
print(os.date('!%H %z %Z', ${summer}))
print(os.date('!%c', 0), os.date('%c', 0))`),
    ).toEqual([
      '14 +0200 Test Daylight Time',
      '12 +0100 Test Standard Time',
      '01/01/70 00:00:00\t01/01/70 01:00:00',
    ])
  })

  it('give the parts of dates as tables, local or in UTC', async () => {
    const show = (format: string) => `local t = os.date('${format}', ${TIME})
local parts = {}
for _, key in ipairs({ 'year', 'month', 'day', 'hour', 'min', 'sec', 'wday', 'yday', 'isdst' }) do
    parts[#parts + 1] = key .. '=' .. tostring(t[key])
end
print(table.concat(parts, ' '))`
    expect(await run([show('*t'), show('!*t')].join('\n'))).toEqual([
      'year=2023 month=11 day=14 hour=23 min=13 sec=20 wday=3 yday=318 isdst=false',
      'year=2023 month=11 day=14 hour=22 min=13 sec=20 wday=3 yday=318 isdst=false',
    ])
  })

  it('give no date for times that MSVC does not take', async () => {
    expect(
      await run(`print(os.date('%c', -1), os.date('%c', 32535215999), os.date('%c', 32535216000))
print(os.date('!%c', -1), os.date('!%c', 32535215999), os.date('!%c', 32535216000))`),
    ).toEqual(['nil\t01/01/01 00:59:59\tnil', 'nil\t12/31/00 23:59:59\tnil'])
    const west: TimeZone = { ...ZONE, offset: () => -300, standardOffset: -300 }
    expect(await run(`print(os.date('%c', 0), os.date('!%c %z', 0))`, { timeZone: west })).toEqual([
      'nil\t01/01/70 00:00:00 -0500',
    ])
  })

  it('say offsets of hours and minutes, and the hours of noon and midnight, as MSVC does', async () => {
    const india: TimeZone = { ...ZONE, offset: () => 330, standardOffset: 330, dstBias: 0 }
    // Midnight and noon of 2023-11-14 in ZONE, which are 4:30 in the morning and afternoon in India.
    const times = `os.date('%I %p', 1699916400), os.date('%I %p', 1699959600)`
    expect([
      await run(`print(os.date('%z', 0), ${times})`, { timeZone: india }),
      await run(`print(${times})`),
    ]).toEqual([['+0530\t04 AM\t04 PM'], ['12 AM\t12 PM']])
  })

  it('end formats at their NUL, or at a % that ends them, and fail for specifiers Windows lacks', async () => {
    expect(
      await run(`print(os.date('abc%', ${TIME}), os.date('a\\0%e', ${TIME}), os.date(12, ${TIME}))
print(pcall(os.date, '%e-%Y'))
print(pcall(os.date, '%#a'))
print(select(2, pcall(function() os.date('%Ec') end)))`),
    ).toEqual([
      'abc\ta\t12',
      "false\tbad argument #1 to 'os.date' (invalid conversion specifier '%e-%Y')",
      "false\tbad argument #1 to 'os.date' (invalid conversion specifier '%#a')",
      "@a/main.lua:4: bad argument #1 to 'date' (invalid conversion specifier '%Ec')",
    ])
  })

  it('check the arguments of dates as Lua does', async () => {
    expect(
      await run(`print(pcall(os.date, {}))
print(pcall(os.date, '%c', 1.5))
print(pcall(os.date, '%c', 'soon'))
print(os.date('%Y', '${TIME}'), os.date(nil, ${TIME}))`),
    ).toEqual([
      "false\tbad argument #1 to 'os.date' (string expected, got table)",
      "false\tbad argument #2 to 'os.date' (number has no integer representation)",
      "false\tbad argument #2 to 'os.date' (number expected, got string)",
      '2023\t11/14/23 23:13:20',
    ])
  })

  it('make times of local dates as MSVC does, with DST as the dates say or as it is then', async () => {
    expect(
      await run(`print(os.time({ year = 2023, month = 11, day = 14, hour = 23, min = 13, sec = 20 }))
print(os.time({ year = 2023, month = 11, day = 14 }), os.time({ year = 2023, month = 11, day = 14, isdst = true }))
print(os.time({ year = 2023, month = 7, day = 1, hour = 14 }), os.time({ year = 2023, month = 7, day = 1, hour = 14, isdst = false }))
print(os.time({ year = 2023, month = 13, day = 1, hour = 0 }))
print(os.time({ year = 1970, month = 1, day = 1, hour = 0 }), os.time({ year = 1970, month = 1, day = 1, hour = 1 }))
print(os.time({ year = 3001, month = 1, day = 1 }))
print(os.time({ year = '2023', month = '11', day = '14', hour = '23', min = '13', sec = '20' }))
local fields = { year = 2023, month = 11, day = 14, hour = 23, min = 13, sec = 20 }
print(os.time(setmetatable({}, { __index = function(_, key) return fields[key] end })))
-- FiveM keeps fields as ints, which hold their lower 32 bits.
print(os.time({ year = 2023, month = 11, day = 14, hour = 23, min = 13, sec = (1 << 32) + 20 }))`),
    ).toEqual([
      `${TIME}`,
      '1699959600\t1699956000',
      '1688212800\t1688216400',
      '1704063600',
      'nil\t0',
      'nil',
      `${TIME}`,
      `${TIME}`,
      `${TIME}`,
    ])
  })

  it('fail for dates without their fields, or that are no tables', async () => {
    expect(
      await run(`print(select(2, pcall(function() os.time({ year = 2023, month = 1 }) end)))
print(select(2, pcall(function() os.time({ year = 2023, month = 1, day = 1.5 }) end)))
print(pcall(os.time, 1))
print(select(2, pcall(os.time, setmetatable({}, { __index = function() error('no fields') end }))))
print(select(2, pcall(function() os.time({ month = 1, day = 1 }) end)))`),
    ).toEqual([
      "@a/main.lua:1: field 'day' missing in date table",
      "@a/main.lua:2: field 'day' missing in date table",
      "false\tbad argument #1 to 'os.time' (table expected, got number)",
      '@a/main.lua:4: no fields',
      "@a/main.lua:5: field 'year' missing in date table",
    ])
  })

  it('count time since the process started, and on the steady clock of the machine', async () => {
    const proc = await server()
    proc.time = 1234.5678
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(os.clock(), math.type(os.clock()))
print(os.microtime(), os.nanotime(), os.rdtsc() == os.nanotime() * 3, os.rdtscp() == os.rdtsc())
print(os.difftime(10, 3), os.deltatime(5, 9), os.deltatime(9, 5), os.deltatime(-1, 1))
print(os.deltatime(math.mininteger, 0))
print(pcall(os.difftime, 10))`,
      }),
    ).toEqual([
      '[script:a] 1.234\tfloat',
      '[script:a] 86401234567\t86401234567000\ttrue\ttrue',
      '[script:a] 7.0\t4\t4\t-2',
      '[script:a] -9223372036854775808',
      "[script:a] false\tbad argument #2 to 'os.difftime' (number expected, got no value)",
    ])
    // Whole seconds are floats all the same.
    proc.time = 2000
    expect(startResource(proc, 'b', { 'main.lua': 'print(os.clock())' })).toEqual([
      '[script:b] 2.0',
    ])
  })

  it('run no commands, know only what system runs the server, and change no locale', async () => {
    expect(
      await run(`print(os.execute(), os.execute('dir'))
print(os.getenv('OS'), os.getenv('Path'), pcall(os.getenv))
print(os.setlocale(), os.setlocale('C'), os.setlocale('fr', 'time'), pcall(os.setlocale, 'C', 'colors'))
print(os.getenv('os\\0path'), os.setlocale('fr\\0ench', 'time\\0zone'), pcall(os.setlocale, 'C', 'x\\0y'))`),
    ).toEqual([
      'true\tnil\tPermission denied\t13',
      "Windows\tnil\tfalse\tbad argument #1 to 'os.getenv' (string expected, got no value)",
      "nil\tC\tfr\tfalse\tbad argument #2 to 'os.setlocale' (invalid option 'colors')",
      // FiveM reads these strings as C does, up to their first NUL.
      "Windows\tfr\tfalse\tbad argument #2 to 'os.setlocale' (invalid option 'x')",
    ])
  })

  it('name temporary files by a count of the whole process', async () => {
    const proc = await server()
    const names = (name: string) =>
      startResource(proc, name, { 'main.lua': 'print(os.tmpname(), os.tmpname())' })
    expect([names('a'), names('b')]).toEqual([
      ['[script:a] tmp_1\ttmp_2'],
      ['[script:b] tmp_3\ttmp_4'],
    ])
  })
})

describe('The files of the os library', () => {
  it('create directories wherever the VFS has a path, but in directories that are not there', async () => {
    const proc = await server()
    proc.add('b', { 'main.lua': '' })
    proc.add('p', { 'fxmanifest.lua': "fx_version 'cerulean'\ngame 'gta5'\nprovide 'q'" })
    expect(
      startResource(proc, 'a', {
        'main.lua': `print(os.createdir('@a/data'))
print(os.createdir('@a/data'))
print(os.createdir('@b/other'), os.createdir('logs'))
print(os.createdir('@a/x/y'))
print(os.createdir('@a/main.lua'))
print(os.createdir('@nothing/d'))
print(os.createdir('@q/d'))
print(os.createdir('_a/d'))
print(os.createdir('@a'))
print(os.createdir('@a\\\\windows'), os.createdir('@nothing'))`,
      }),
    ).toEqual([
      '[script:a] true',
      '[script:a] nil\t@a/data: Directory already exists.\t1',
      '[script:a] true\ttrue',
      '[script:a] nil\t@a/x/y: Failed to create directory\t1',
      '[script:a] nil\t@a/main.lua: Failed to create directory\t1',
      '[script:a] nil\t@nothing/d: Failed to create directory\t1',
      // Only the names of resources themselves begin their mounts, after an @.
      '[script:a] nil\t@q/d: Failed to create directory\t1',
      '[script:a] nil\t_a/d: Failed to create directory\t1',
      // A resource is a directory itself.
      '[script:a] nil\t@a: Directory already exists.\t1',
      // Paths on Windows have backslashes too, and the server's own files take the paths of no resource.
      '[script:a] true\ttrue',
    ])
    const { files } = proc.manager
    expect(
      ['resources/a/data', 'resources/b/other', 'logs', 'resources/a/windows', '@nothing'].map(
        (path) => files.list(path),
      ),
    ).toEqual([[], [], [], [], []])
  })

  it('remove and move files where the resource may write them', async () => {
    const proc = await server()
    proc.add('b', { 'main.lua': '', 'b.txt': 'b' })
    proc.add('c', { 'main.lua': '', 'c.txt': 'c' })
    runCommand(proc.manager, 'add_filesystem_permission a write c', 'system.console')
    runCommand(proc.manager, 'add_filesystem_permission a write other', 'system.console')
    expect(
      startResource(proc, 'a', {
        'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'`,
        'main.lua': `print(os.remove('@a/one.txt\\0ignored'))
print(os.remove('@a/one.txt'))
print(os.remove('@b/b.txt'))
print(os.remove('@c/c.txt'))
print(os.remove('@a/data'))
print(os.rename('@a/two.txt', '@a/three.txt'))
print(os.rename('@a/three.txt', 'three.txt'))
print(os.rename('@a/three.txt', '@a/'))
print(os.rename('@a', '@c/a'))
print(os.rename('@b/b.txt', '@a/moved.txt'))
print(os.rename('@a/four.txt', '@other'))
print(os.rename('@a/four.txt', '@a\\\\five.txt'))`,
        'one.txt': '1',
        'two.txt': '2',
        'four.txt': '4',
        'data/x.txt': 'x',
      }),
    ).toEqual([
      '[script:a] true',
      '[script:a] nil\t@a/one.txt: Permission denied\t13',
      '[script:a] nil\t@b/b.txt: Permission denied\t13',
      '[script:a] true',
      '[script:a] nil\t@a/data: Permission denied\t13',
      '[script:a] true',
      '[script:a] nil\t@a/three.txt -> three.txt: Permission denied\t13',
      '[script:a] nil\t@a/three.txt -> @a/: Permission denied\t13',
      '[script:a] nil\t@a -> @c/a: Permission denied\t13',
      '[script:a] nil\t@b/b.txt -> @a/moved.txt: Permission denied\t13',
      '[script:a] nil\t@a/four.txt -> @other: Permission denied\t13',
      '[script:a] true',
    ])
    const { files } = proc.manager
    expect(
      [
        'resources/a/one.txt',
        'resources/b/b.txt',
        'resources/c/c.txt',
        'resources/a/three.txt',
        'resources/a/data/x.txt',
        'resources/a/five.txt',
      ].map((path) => files.read(path)?.length),
    ).toEqual([undefined, 1, undefined, 1, 1, 1])
  })

  it('take paths without an @ as those of the resource whose directory holds them', async () => {
    const proc = await server()
    proc.add('b', { 'main.lua': '', 'b.txt': 'b' })
    addFile(proc.manager.files, 'logs/old.txt', 'old')
    addFile(proc.manager.files, 'resources/logs2/one.txt', '1')
    expect(
      startResource(proc, 'logs', {
        'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'`,
        'main.lua': `print(os.remove('resources/logs2/one.txt'))
print(os.remove('resources/logs/one.txt'))
print(os.remove('logs/old.txt'))
print(os.rename('logs/old.txt', 'resources/logs/old.txt'))
print(os.remove('resources/b/b.txt'))
print(os.remove('resources/logs'))
print(os.rename('resources/logs/two.txt', 'resources/./logs/three.txt'))
print(os.rename('resources/logs/three.txt', 'three.txt'))
print(os.remove('@logs\\\\three.txt'))`,
        'one.txt': '1',
        'two.txt': '2',
      }),
    ).toEqual([
      '[script:logs] nil\tresources/logs2/one.txt: Permission denied\t13',
      '[script:logs] true',
      '[script:logs] nil\tlogs/old.txt: Permission denied\t13',
      '[script:logs] nil\tlogs/old.txt -> resources/logs/old.txt: Permission denied\t13',
      '[script:logs] nil\tresources/b/b.txt: Permission denied\t13',
      '[script:logs] nil\tresources/logs: Permission denied\t13',
      '[script:logs] true',
      '[script:logs] nil\tresources/logs/three.txt -> three.txt: Permission denied\t13',
      // A backslash after the name begins no mount, so the path is one of the server's own files.
      '[script:logs] nil\t@logs\\three.txt: Permission denied\t13',
    ])
    const { files } = proc.manager
    expect(
      [
        'resources/logs2/one.txt',
        'resources/logs/one.txt',
        'logs/old.txt',
        'resources/b/b.txt',
        'resources/logs/three.txt',
      ].map((path) => files.read(path)?.length),
    ).toEqual([1, undefined, 3, 1, 1])
  })

  it('move files on the resource they come from, whatever resource the target names', async () => {
    const proc = await server()
    proc.add('c', { 'main.lua': '' })
    proc.add('abc', { 'main.lua': '' })
    runCommand(proc.manager, 'add_filesystem_permission a write c', 'system.console')
    runCommand(proc.manager, 'add_filesystem_permission a write abc', 'system.console')
    expect(
      startResource(proc, 'a', {
        'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'`,
        // FiveM takes as many characters off the target as @a/ has.
        'main.lua': `print(os.rename('@a/one.txt', '@c/moved.txt'))
print(os.rename('@a/two.txt', '@abc/moved.txt'))`,
        'one.txt': '1',
        'two.txt': '2',
        'c/kept.txt': '',
      }),
    ).toEqual(['[script:a] true', '[script:a] true'])
    const { files } = proc.manager
    expect(
      [
        'resources/a/moved.txt',
        'resources/c/moved.txt',
        'resources/a/c/moved.txt',
        'resources/abc/moved.txt',
      ].map((path) => files.read(path)?.length),
    ).toEqual([1, undefined, 1, undefined])
  })

  it('remove and move no files that handles have open, nor the directories they are in', async () => {
    const proc = await server()
    const resource = proc.add('a', {
      'fxmanifest.lua': `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'`,
      'main.lua': `print(os.remove('@a/open.txt'))
print(os.rename('@a/open.txt', '@a/moved.txt'))
print(os.rename('@a/dir', '@a/moved'))
print(os.remove('@a/free.txt'))`,
      'open.txt': 'o',
      'free.txt': 'f',
      'dir/inner.txt': 'i',
    })
    const { openFiles, files } = proc.manager
    openFiles.openExisting('resources/a/open.txt', 'read')
    openFiles.openExisting('resources/a/dir/inner.txt', 'read')
    resource.start()
    expect([
      proc.take().filter((line) => line.startsWith('[script:a]')),
      files.read('resources/a/open.txt')?.length,
      files.list('resources/a/dir'),
    ]).toEqual([
      [
        '[script:a] nil\t@a/open.txt: Permission denied\t13',
        '[script:a] nil\t@a/open.txt -> @a/moved.txt: Permission denied\t13',
        '[script:a] nil\t@a/dir -> @a/moved: Permission denied\t13',
        '[script:a] true',
      ],
      1,
      [{ name: 'inner.txt', directory: false }],
    ])
  })
})
