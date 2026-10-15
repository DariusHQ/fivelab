import { describe, expect, it } from 'vitest'

import { createProcess, runCommand, startResource, type TestProcess } from './helpers.ts'

const MANIFEST = `fx_version 'cerulean'
game 'gta5'
server_script 'main.lua'`

/** Lua that writes values on one line, with their line breaks shown as \n. */
const SHOW = `local function show(...)
    local values = table.pack(...)
    for i = 1, values.n do
        local value = values[i]
        values[i] = type(value) == 'string' and (value:gsub('\\n', '\\\\n'):gsub('\\r', '\\\\r')) or tostring(value)
    end
    print(table.concat(values, ' ', 1, values.n))
end
local function fails(fn, ...)
    local ok, message = pcall(fn, ...)
    return ok and 'no error' or (tostring(message):gsub('^@a/main%.lua:%d+: ', ''))
end
`

/** What resource a prints as it runs `lua` with `files`, after SHOW. */
async function run(
  lua: string,
  files: Record<string, string> = {},
  proc?: TestProcess,
): Promise<string[]> {
  const process = proc ?? (await createProcess())
  return startResource(process, 'a', {
    'fxmanifest.lua': MANIFEST,
    'main.lua': SHOW + lua,
    ...files,
  }).map((line) => line.replace(/^\[script:a\] /, ''))
}

describe('The io library of servers', () => {
  it('is FiveM own, loaded as a library, and clients have none', async () => {
    const client = await createProcess({ side: 'client' })
    expect([
      await run(`local names = {}
for name in pairs(io) do names[#names + 1] = name end
table.sort(names)
show(table.concat(names, ' '))
show(require('io') == io, io.write == print, io.close == getmetatable(io.stdout).close)
show(io.lines() == io.lines(), io.lines('@a/main.lua')())`),
      startResource(client, 'c', { 'main.lua': 'print(io)' }),
    ]).toEqual([
      [
        'close flush lines open popen readdir stderr stdin stdout tmpfile type write',
        'true false true',
        // io.lines reads no file, but gives the same iterator, which gives nothing.
        'true',
      ],
      ['[script:c] nil'],
    ])
  })

  it('reads lines, numbers, counts and the rest of files', async () => {
    expect(
      await run(
        `local f = io.open('@a/data.txt')
show(io.type(f), f:read(), f:read('L'), f:read('*l'), f:read(3), f:read('n', 'n', 'n'))
show(f:read('a'), f:read('a'), f:read('l'), f:read(1), f:read('L'))
f:seek('set', 0)
show(f:read('lol'), f:read('Line'), f:read('all'))`,
        { 'data.txt': 'one\ntwo\n\nabc  12 0x1F -3.5e2 rest\nlast' },
      ),
    ).toEqual([
      'file one two\\n  abc 12 31 -350.0',
      ' rest\\nlast  nil nil nil',
      'one two\\n \\nabc  12 0x1F -3.5e2 rest\\nlast',
    ])
  })

  it('reads numbers as Lua does, and moves back a byte after them even at the end', async () => {
    expect(
      await run(
        `local f = io.open('@a/numbers.txt')
show(f:read('n', 'n', 'n', 'n'))
show(f:read('n'), f:read(1))
show(f:read('n'), f:seek())
local last = io.open('@a/last.txt')
show(last:read('n'), last:seek(), last:read('a'))
show(io.open('@a/long.txt'):read('n'), io.open('@a/empty.txt'):read('n'))
local more = io.open('@a/more.txt')
show(more:read('n', 'n', 'n'))
show(more:read(1), more:read('n'), more:read('a'))
show(fails(function() return more:read(2^40) end))`,
        {
          'numbers.txt': ' +7\t-0x10p1 .5e-1 0x.8 x',
          'last.txt': '42',
          'long.txt': '1'.repeat(201),
          'empty.txt': '',
          'more.txt': '0xff 0e1 1e1f e5',
        },
      ),
    ).toEqual([
      '7 -32.0 0.05 0.5',
      'nil x',
      // FiveM moves back a byte from the end, where it read nothing.
      'nil 23',
      '42 1 2',
      'nil nil',
      // Exponents are decimal, and need digits before them.
      '255 0.0 10.0',
      'f nil e5',
      'not enough memory',
    ])
  })

  it('reads 0 bytes as FiveM does, which leaves the count where results go', async () => {
    expect(
      await run(
        `local f = io.open('@a/data.txt')
show(f:read(0))
show(f:read('l', 0))
show(f:read(0.0))
f:read('a')
show(f:read(0))
show(f:read(0, 'l'))
f:seek('set', 9)
show(f:read(0, 'l', true))`,
        { 'data.txt': 'ab\ncd' },
      ),
    ).toEqual(['0', '0 ab', '0.0', 'nil', 'nil', 'true nil'])
  })

  it('fails on formats and handles it does not take, as FiveM does', async () => {
    expect(
      await run(
        `local f = io.open('@a/data.txt')
local d = io.readdir('@a')
show(fails(function() return f:read('x') end))
show(fails(function() return f:read(1.5) end))
show(fails(function() return f:read({}) end))
show(fails(function() return f:read('l', '') end), f:seek())
show(fails(function() return f:read(-1) end))
show(fails(function() return f.read(d) end))
show(fails(function() return d:lines(f) end), fails(function() return io.type() end))
f:close()
show(select(2, pcall(function() return f:read() end)), select(2, pcall(f.read, f)))
show(fails(function() return f:close() end), fails(io.close), fails(io.close, d))`,
        { 'data.txt': 'ab\ncd' },
      ),
    ).toEqual([
      "bad argument #1 to 'read' (invalid format)",
      "bad argument #1 to 'read' (number has no integer representation)",
      "bad argument #1 to 'read' (string expected, got table)",
      "bad argument #2 to 'read' (invalid format) 3",
      // A count that does not fit a size_t is too much to make room for.
      'not enough memory',
      "bad argument #1 to 'read' (FILE* expected, got DIRECTORY*)",
      "no error bad argument #1 to 'type' (value expected)",
      // The error is where the Lua code that called is, which pcall, in C, is not.
      '@a/main.lua:23: attempt to use a closed file attempt to use a closed file',
      "attempt to use a closed file bad argument #1 to 'io.close' (FILE* expected, got no value) bad argument #1 to 'io.close' (FILE* expected, got DIRECTORY*)",
    ])
  })

  it('writes where the handle is, cuts what follows, and writes numbers as C does', async () => {
    expect(
      await run(
        `local f = io.open('@a/data.txt', 'w')
show(io.type(f), f:read(2), f:write('XY') == f)
f:seek('set', 0)
show(f:read('a'))
f:write(1, ' ', 1.0, ' ', 0.1, ' ', -0.0, ' ', 1e100, ' ', 2^63, ' ', math.mininteger)
f:seek('set', 0)
show(f:read('a'))
show(fails(function() return f:write('ok', {}) end), f:seek())
local log = io.open('@a/log.txt', 'a')
log:write('one\\n')
log:seek('set', 0)
log:write('two\\n')
log:seek('set', 0)
show(log:read('a'), log:seek())
local reader = io.open('@a/data.txt')
show(reader:write('x'))`,
        { 'data.txt': 'abcdef' },
      ),
    ).toEqual([
      'file ab true',
      'abXY',
      'abXY1 1 0.1 -0 1e+100 9.2233720368548e+18 -9223372036854775808',
      // FiveM checks what it writes as it goes, after it wrote what came before.
      "bad argument #2 to 'write' (string expected, got table) 64",
      'one\\ntwo\\n 8',
      'nil No error 0',
    ])
  })

  it('opens files through the VFS, to write only where the resource may', async () => {
    const proc = await createProcess()
    proc.add('b', { 'main.lua': '', 'b.txt': 'b' })
    proc.add('c', { 'main.lua': '', 'c.txt': 'cc' })
    runCommand(proc.manager, 'add_filesystem_permission a write c', 'system.console')
    expect(
      await run(
        `local b = io.open('@b/b.txt', 'w')
show(b:read('a'), b:write('x'))
local c = io.open('@c/c.txt', 'w')
show(c:write('C') == c, c:seek('set', 0), c:read('a'))
local made = io.open('@a/made.txt', 'r+')
show(made:write('m') == made, io.open('@a/made.txt'):read('a'))
show(io.open('@a/data.txt', 'w+'):read('a'))
show(io.open('resources/a/data.txt'):read('a'), io.open('resources/b/b.txt', 'a'):write('x'))
show(io.open('@a/../b/b.txt'))
show(io.open('resources\\\\a\\\\..\\\\a\\\\data.txt'))
show(io.open('@b/new.txt', 'r+'))
show(io.open('@b/b.txt', 'a+'):write('x'))
show(io.open('@nothing/x.txt', 'w'))
show(io.open('@a\\\\data.txt'))
show(io.open('server.cfg'))
show(io.open('@a/dir', 'w'))
show(io.open('@a/missing.txt'))`,
        { 'data.txt': 'data', 'dir/inner.txt': '' },
        proc,
      ),
    ).toEqual([
      'b nil No error 0',
      'true 0 C',
      'true m',
      'data',
      'data nil No error 0',
      'nil @a/../b/b.txt: No such file or directory 2',
      // Windows separates the parts of paths with backslashes too.
      'nil resources\\a\\..\\a\\data.txt: No such file or directory 2',
      // Where the resource may not write, + creates nothing and a writes nothing.
      'nil @b/new.txt: No such file or directory 2',
      'nil No error 0',
      'nil @nothing/x.txt: No such file or directory 2',
      // A backslash after the name begins no mount: the path is one of the server's own files.
      'nil @a\\data.txt: No such file or directory 2',
      'nil server.cfg: No such file or directory 2',
      'nil @a/dir: No such file or directory 2',
      'nil @a/missing.txt: No such file or directory 2',
    ])
  })

  it('opens files as Windows shares them, and closes those that are collected', async () => {
    const proc = await createProcess()
    expect(
      await run(
        `local created = io.open('@a/shared.txt', 'w')
show(io.open('@a/shared.txt', 'w'))
show(io.type(io.open('@a/shared.txt')), os.remove('@a/shared.txt'))
created:close()
show(io.type(io.open('@a/shared.txt', 'w')))
local function make() io.open('@a/gc.txt', 'w'):write('x') end
make()
show(os.remove('@a/gc.txt'))
collectgarbage()
collectgarbage()
show(os.remove('@a/gc.txt'))
held = io.open('@a/held.txt', 'w')`,
        {},
        proc,
      ),
    ).toEqual([
      // The file that io.open created shares no writes until it closes.
      'nil @a/shared.txt: No such file or directory 2',
      'file nil @a/shared.txt: Permission denied 13',
      'file',
      'nil @a/gc.txt: Permission denied 13',
      'true',
    ])
    const { openFiles, getResource } = proc.manager
    const before = openFiles.inUse('resources/a/held.txt')
    getResource.call(proc.manager, 'a')!.stop()
    expect([before, openFiles.inUse('resources/a/held.txt')]).toEqual([true, false])
  })

  it('seeks as SetFilePointer does, buffers nothing and flushes what it may write', async () => {
    expect(
      await run(
        `local f = io.open('@a/data.txt', 'w')
show(f:seek(), f:seek('end'), f:seek('set', 2), f:seek('cur', -1), f:seek('cur', -5), f:seek('set', 2^32 + 3))
show(f:seek('set\\0x', 1), fails(function() return f:seek('bad') end))
show(fails(function() return f:seek('set', 1.5) end))
show(f:setvbuf('no'), f:setvbuf('full', 1024), fails(function() return f:setvbuf() end))
show(fails(function() return f:setvbuf('line', {}) end))
show(f:flush(), io.open('@a/data.txt', 'a'):flush(), io.open('@a/data.txt'):flush())`,
        { 'data.txt': 'abcdef' },
      ),
    ).toEqual([
      // SetFilePointer fails before the start, and takes the low 32 bits of offsets.
      '0 6 2 1 4294967295 3',
      "1 bad argument #1 to 'seek' (invalid option 'bad')",
      "bad argument #2 to 'seek' (number has no integer representation)",
      "true true bad argument #1 to 'setvbuf' (string expected, got no value)",
      "bad argument #2 to 'setvbuf' (number expected, got table)",
      'true true nil No error 0',
    ])
  })

  it('iterates over lines as FiveM does, which skips empty ones and reads ahead', async () => {
    const long = `${'a'.repeat(65535)}\n\nb`
    expect(
      await run(
        `local lines = {}
for line in io.open('@a/lines.txt'):lines() do lines[#lines + 1] = line end
show(table.concat(lines, '|'))
local f = io.open('@a/lines.txt')
local nextLine = f:lines()
show(nextLine(), f:read('a'), f:seek())
show(nextLine(), nextLine())
f:close()
show(nextLine())
local sizes = {}
for line in io.open('@a/long.txt'):lines() do sizes[#sizes + 1] = #line end
show(table.concat(sizes, ' '))
show(fails(function() return f:lines() end))`,
        { 'lines.txt': 'one\r\ntwo\n\n\nthree\rfour\nlast', 'long.txt': long },
      ),
    ).toEqual([
      'one|two|three|four|last',
      // The iterator read the whole file ahead, which leaves nothing for f:read.
      'one  26',
      'two three',
      '',
      // Line ends on both sides of 64 KiB make an empty line, as FiveM reads 64 KiB at a time.
      '65535 0 1',
      'attempt to use a closed file',
    ])
  })

  it('lists directories through the VFS, and as the dir and ls commands of io.popen', async () => {
    expect(
      await run(
        `local d = io.readdir('@a')
show(tostring(d))
local names = {}
for name in d:lines() do names[#names + 1] = name end
show(table.concat(names, ' '))
show(d:close(), tostring(d), fails(function() return d:lines() end), d:close())
show(tostring(io.readdir('@a\\\\dir')), tostring(io.readdir('resources/a/dir')))
show(tostring(io.readdir('@a/missing')), tostring(io.readdir('@a/a.txt')))
show(tostring(io.popen('dir "resources/a/dir"')), tostring(io.popen('ls "resources/a/dir"', 'r')))
show(tostring(io.popen('dir "resources/a/a.txt"')))
show(io.popen('dir resources/a'))
show(io.popen('echo "x"'))
show(io.popen('dir "@a/dir"'))
show(fails(function() return io.popen('dir "resources/a"', {}) end))`,
        { 'B.txt': '', 'a.txt': '', '_x.txt': '', abc: '', ab: '', 'dir/inner.txt': '' },
      ),
    ).toEqual([
      // NTFS lists names by their upper case, and those that others begin before them.
      'a.txt\\nab\\nabc\\nB.txt\\ndir\\nfxmanifest.lua\\nmain.lua\\n_x.txt\\n',
      'a.txt ab abc B.txt dir fxmanifest.lua main.lua _x.txt',
      "true directory (closed) calling 'lines' on bad self (directory is closed) true",
      'inner.txt\\n inner.txt\\n',
      ' ',
      '.\\n..\\ninner.txt\\n .\\n..\\ninner.txt\\n',
      '',
      'nil dir resources/a: No error 0',
      'nil echo "x": No error 0',
      'nil dir "@a/dir": No error 0',
      "bad argument #2 to 'popen' (string expected, got table)",
    ])
  })

  it('writes to the console as print does, and has only closed input and output files', async () => {
    expect(
      await run(`io.write('a', 1, 2.5)
show(io.type(io.stdout), tostring(io.stdin), fails(function() return io.stderr:write('x') end))
show(io.flush())
show(io.tmpfile())
show(tostring(io.open('@a/main.lua')), io.type(42))`),
    ).toEqual([
      'a\t1\t2.5',
      'closed file file (closed) attempt to use a closed file',
      'nil No error 0',
      'nil No error 0',
      // CfxLua writes no addresses for %p, as FiveM builds it.
      'file (<pointer>) nil',
    ])
  })
})
