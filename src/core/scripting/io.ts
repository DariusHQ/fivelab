import {
  CFunction,
  LuaArgumentError,
  LuaCallerError,
  LuaError,
  LuaFloat,
  LuaRef,
  type HostArgs,
  type LuaHostFunction,
  type LuaState,
  type LuaValue,
} from '../lua/index.ts'
import { LUA_TNUMBER, LUA_TSTRING } from '../lua/abi.ts'
import {
  checkAny,
  checkCString,
  checkInteger,
  checkOption,
  checkString,
  optionalInteger,
  optionalString,
  typeError,
  untilNul,
} from './checks.ts'

/** A file that a script has open, as FiveM's VFS streams it. */
export interface IoFile {
  /** Where the next read or write goes, from the start, which can be past the end. */
  readonly position: number
  length(): number
  /** Reads up to `count` bytes, and moves past them. */
  read(count: number): Uint8Array
  /** Writes `bytes`, and moves past them, unless the file may not be written. */
  write(bytes: Uint8Array): boolean
  /** Moves to `offset` from the start, the position or the end, as SetFilePointer does. */
  seek(offset: bigint, from: 'set' | 'cur' | 'end'): number
  /** Cuts or grows the file to `length`, and moves there, unless the file may not be written. */
  truncate(length: number): boolean
  flush(): boolean
  close(): void
}

/** How FiveM's io.open opens a file, as it reads its mode. */
export interface IoOpenFlags {
  readonly write: boolean
  readonly append: boolean
  readonly create: boolean
}

/** What FiveM's io library reaches of the process, which it has on servers. */
export interface IoHost {
  /** Opens a file as io.open does once it read its mode, or gives none, which it reports as missing. */
  open(path: string, flags: IoOpenFlags): IoFile | undefined
  /** The names in a directory, as io.readdir lists them. */
  readDirectory(path: string): string[]
  /** The names that io.popen lists for a "dir" or "ls" of a path, or none where it fails. */
  listCommand(path: string): string[] | undefined
}

/** The metatables of the handles of FiveM's io, as their __name says in errors. */
const FILE_HANDLE = 'FILE*'
const DIRECTORY_HANDLE = 'DIRECTORY*'
/** The metatable of what a line iterator of a file reads ahead, which it keeps as one of its upvalues. */
const LINE_BUFFER = 'FILE* lines'

/** How much a line iterator of FiveM reads ahead of the lines it gives. */
const LINE_CHUNK = 64 * 1024

/** strerror(ENOENT), which io.open reports for every file it does not open. */
const ENOENT = 2
const NO_SUCH_FILE = 'No such file or directory'

/**
 * What FiveM reports where it gives errno as earlier calls left it, as
 * luaL_fileresult does: FiveRunner takes it to be 0, which MSVC calls
 * "No error".
 */
const NO_ERROR = [null, 'No error', 0]

/** The largest count f:read takes before it fails to make room, as FiveM does for negative ones. */
const MAX_READ = 0x7fff_ffff

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** What a line iterator of a file read ahead, and where it is in it. */
interface LineBuffer {
  bytes: Uint8Array
  position: number
}

/** An argument of f:read that stays on the stack, which reads as it was only if it is returned. */
class Argument {
  readonly index: number
  constructor(index: number) {
    this.index = index
  }
}

/** The bytes that end lines for the line iterators of FiveM's files, which skip them all. */
function endsLine(byte: number | undefined): boolean {
  return byte === 0x0a || byte === 0x0d
}

/** Whether a byte is a space as C's isspace finds it in the C locale. */
function isSpace(byte: number): boolean {
  return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d)
}

/** Joins bytes into one string of them. */
function concatenate(parts: readonly Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let at = 0
  for (const part of parts) {
    joined.set(part, at)
    at += part.length
  }
  return joined
}

/**
 * The io library of FiveM's servers: io.open and io.readdir through the
 * VFS and its permissions, io.popen only for listing directories, and no
 * input or output files but closed ones, so that io.write prints as print
 * does, io.lines gives nothing, and io.flush and io.tmpfile fail.
 */
export function ioLibrary(state: LuaState, host: IoHost, writer: LuaHostFunction): LuaRef {
  /** The open files of the FILE* handles by their ids, which are null once closed. */
  const files = new Map<number, IoFile | null>()
  /** The names of the DIRECTORY* handles by their ids, which are null once closed. */
  const directories = new Map<number, string[] | null>()
  const lineBuffers = new Map<number, LineBuffer>()
  let nextId = 1

  const handle = (type: string, id: number) => state.returning(state.newUserdata(type, id))
  const newFile = (file: IoFile) => {
    files.set(nextId, file)
    return handle(FILE_HANDLE, nextId++)
  }
  const newDirectory = (names: string[]) => {
    directories.set(nextId, names)
    return handle(DIRECTORY_HANDLE, nextId++)
  }

  /** The id of the FILE* at argument `index`, as luaL_checkudata takes it. */
  const fileId = (args: HostArgs, index: number) =>
    args.userdata(index, FILE_HANDLE) || typeError(args, index, FILE_HANDLE)
  /** The file of the FILE* that a function of FiveM's io gets first, which must be open. */
  const openFile = (args: HostArgs) => {
    const file = files.get(fileId(args, 1))
    if (file == null) throw new LuaCallerError('attempt to use a closed file')
    return file
  }
  const close = (args: HostArgs) => {
    openFile(args).close()
    files.set(fileId(args, 1), null)
    return true
  }
  const directoryId = (args: HostArgs) =>
    args.userdata(1, DIRECTORY_HANDLE) || typeError(args, 1, DIRECTORY_HANDLE)

  /** Reads a byte as FiveM's io does, which reads them one at a time: undefined at the end. */
  const getc = (file: IoFile) => file.read(1)[0]
  /** Moves back a byte, as FiveM's io does after it looked ahead, even past nothing at the end. */
  const ungetc = (file: IoFile) => file.seek(-1n, 'cur')

  /** Reads a line, without or with its \n: the line, and whether there was one. */
  const readLine = (file: IoFile, keepEnd: boolean): [Uint8Array, boolean] => {
    const parts: Uint8Array[] = []
    for (;;) {
      const chunk = file.read(4096)
      const end = chunk.indexOf(0x0a)
      if (end === -1) {
        parts.push(chunk)
        if (chunk.length === 0) break
        continue
      }
      parts.push(chunk.subarray(0, keepEnd ? end + 1 : end))
      // Like FiveM, it reads no further than the end of the line.
      file.seek(BigInt(end + 1 - chunk.length), 'cur')
      return [concatenate(parts), true]
    }
    const line = concatenate(parts)
    return [line, line.length > 0]
  }

  /**
   * Reads a number as Lua's io reads one, through a numeral of at most 200
   * characters, which lua_stringtonumber then converts, or nil.
   */
  const readNumber = (file: IoFile): LuaValue => {
    const numeral: number[] = []
    let c = getc(file)
    while (c !== undefined && isSpace(c)) c = getc(file)
    let overflow = false
    const take = () => {
      if (numeral.length >= 200) {
        overflow = true
        return false
      }
      numeral.push(c!)
      c = getc(file)
      return true
    }
    const accept = (set: string) =>
      c !== undefined && set.includes(String.fromCharCode(c)) && take()
    const digits = (hex: boolean) => {
      let count = 0
      const isDigit = (byte: number) =>
        (byte >= 0x30 && byte <= 0x39) ||
        (hex && ((byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66)))
      while (c !== undefined && isDigit(c) && take()) count++
      return count
    }
    accept('-+')
    let count = 0
    let hex = false
    if (accept('0')) {
      if (accept('xX')) hex = true
      else count = 1
    }
    count += digits(hex)
    if (accept('.')) count += digits(hex)
    if (count > 0 && accept(hex ? 'pP' : 'eE')) {
      accept('-+')
      digits(false)
    }
    ungetc(file)
    if (overflow) return null
    return state.stringToNumber(String.fromCharCode(...numeral)) ?? null
  }

  /** Reads the rest of a file. */
  const readAll = (file: IoFile) => file.read(Math.max(file.length() - file.position, 0))

  /**
   * Reads with the formats of f:read as FiveM does, which leaves nothing on
   * the stack for a count of 0, so that what it returns then are the last of
   * the arguments and the results, as many as there are formats.
   */
  const read = (args: HostArgs, file: IoFile): LuaValue | LuaValue[] => {
    if (args.count === 1) {
      const [line, found] = readLine(file, false)
      return found ? line : null
    }
    const stack: (LuaValue | Argument)[] = []
    for (let i = 2; i <= args.count; i++) stack.push(new Argument(i))
    let formats = 0
    let success = true
    for (let n = 2; n <= args.count && success; n++, formats++) {
      if (args.type(n) === LUA_TNUMBER) {
        const count = checkInteger(args, n)
        if (count === 0n) {
          success = file.position !== file.length()
          continue
        }
        if (count < 0n || count > BigInt(MAX_READ)) throw new LuaError('not enough memory')
        const bytes = file.read(Number(count))
        stack.push(bytes)
        success = bytes.length > 0
        continue
      }
      let format = checkString(args, n)
      if (format[0] === 0x2a) format = format.subarray(1)
      switch (format[0]) {
        case 0x6e: {
          const number = readNumber(file)
          stack.push(number)
          success = number !== null
          break
        }
        case 0x6c:
        case 0x4c: {
          const [line, found] = readLine(file, format[0] === 0x4c)
          stack.push(line)
          success = found
          break
        }
        case 0x61:
          stack.push(readAll(file))
          break
        default:
          throw new LuaArgumentError(n, 'invalid format')
      }
    }
    if (!success) {
      stack.pop()
      stack.push(null)
    }
    return stack.slice(stack.length - formats).map((value) => {
      if (!(value instanceof Argument)) return value
      const { index } = value
      if (args.type(index) === LUA_TSTRING) return args.bytes(index)
      if (args.type(index) === LUA_TNUMBER && !args.isInteger(index)) {
        return new LuaFloat(args.get(index) as number)
      }
      const argument = args.get(index)
      return argument instanceof LuaRef ? state.returning(argument) : argument
    })
  }

  /** Writes the arguments after the file, as f:write does, and cuts what follows them. */
  const write = (args: HostArgs, file: IoFile): LuaValue | LuaValue[] => {
    const length = file.length()
    let written = true
    for (let i = 2; i <= args.count; i++) {
      let bytes: Uint8Array
      if (args.type(i) === LUA_TNUMBER) {
        const text = args.isInteger(i)
          ? args.integer(i).toString()
          : state.formatFloat(args.get(i) as number)
        bytes = encoder.encode(text)
      } else {
        bytes = checkString(args, i)
      }
      written &&= file.write(bytes)
    }
    // FiveM cuts the file after what it wrote, wherever that is, which handles that fail to write cannot.
    if (file.position < length) file.truncate(file.position)
    return written ? state.returning(args.get(1) as LuaRef) : NO_ERROR
  }

  const nextLine = state.hostFunction((args) => {
    const file = files.get(args.userdata(args.upvalueIndex(1), FILE_HANDLE))
    if (file == null) return undefined
    const buffer = lineBuffers.get(args.userdata(args.upvalueIndex(2), LINE_BUFFER))!
    if (file.position >= file.length() && buffer.position >= buffer.bytes.length) return undefined
    const parts: Uint8Array[] = []
    for (;;) {
      if (buffer.position >= buffer.bytes.length) {
        buffer.bytes = file.read(LINE_CHUNK)
        buffer.position = 0
        if (buffer.bytes.length === 0) break
      }
      const { bytes } = buffer
      const start = buffer.position
      while (buffer.position < bytes.length && !endsLine(bytes[buffer.position])) buffer.position++
      parts.push(bytes.subarray(start, buffer.position))
      if (buffer.position < bytes.length) {
        // It skips every line end that follows, which leaves out empty lines.
        while (buffer.position < bytes.length && endsLine(bytes[buffer.position])) buffer.position++
        break
      }
    }
    return concatenate(parts)
  })

  const nextName = state.hostFunction((args) => {
    const names = directories.get(args.userdata(args.upvalueIndex(1), DIRECTORY_HANDLE))
    const index = Number(args.upvalue(2))
    if (names == null || index >= names.length) return undefined
    args.setUpvalue(2, index + 1)
    return names[index]
  })

  /** The functions of the file handles, and the methods of those whose metatables give them. */
  const closeFunction = state.hostClosure(state.hostFunction(close))
  const fileMethods: [string, LuaValue][] = [
    ['close', closeFunction],
    ['flush', state.hostFunction((args) => (openFile(args).flush() ? true : NO_ERROR))],
    [
      'lines',
      state.hostFunction((args) => {
        openFile(args)
        const id = nextId++
        lineBuffers.set(id, { bytes: new Uint8Array(), position: 0 })
        const self = args.get(1) as LuaRef
        const buffer = state.newUserdata(LINE_BUFFER, id)
        const iterator = state.hostClosure(nextLine, self, buffer)
        self.release()
        buffer.release()
        return state.returning(iterator)
      }),
    ],
    ['read', state.hostFunction((args) => read(args, openFile(args)))],
    [
      'seek',
      state.hostFunction((args) => {
        const file = openFile(args)
        const from = (['set', 'cur', 'end'] as const)[
          checkOption(args, 2, 'cur', ['set', 'cur', 'end'])
        ]!
        // FiveM checks for -1 in 64 bits, which the 32-bit error of SetFilePointer never is.
        return file.seek(optionalInteger(args, 3, 0n), from)
      }),
    ],
    [
      'setvbuf',
      state.hostFunction((args) => {
        openFile(args)
        checkOption(args, 2, undefined, ['no', 'full', 'line'])
        optionalInteger(args, 3, 0n)
        return true
      }),
    ],
    ['write', state.hostFunction((args) => write(args, openFile(args)))],
    [
      '__gc',
      state.hostFunction((args) => {
        const id = fileId(args, 1)
        files.get(id)?.close()
        files.delete(id)
      }),
    ],
    [
      '__tostring',
      state.hostFunction((args) =>
        files.get(fileId(args, 1)) == null ? 'file (closed)' : 'file (<pointer>)',
      ),
    ],
  ]
  // CfxLua writes no addresses for %p, as FiveM builds it, so files write <pointer> instead.
  const fileMeta = state.newMetatable(FILE_HANDLE, fileMethods)
  state.rawSet(fileMeta, '__index', fileMeta)

  const directoryMeta = state.newMetatable(DIRECTORY_HANDLE, [
    [
      'close',
      state.hostFunction((args) => {
        directories.set(directoryId(args), null)
        return true
      }),
    ],
    [
      'lines',
      state.hostFunction((args) => {
        if (directories.get(directoryId(args)) == null) {
          throw new LuaArgumentError(1, 'directory is closed')
        }
        const self = args.get(1) as LuaRef
        const iterator = state.hostClosure(nextName, self, 0)
        self.release()
        return state.returning(iterator)
      }),
    ],
    [
      '__gc',
      state.hostFunction((args) => {
        directories.delete(directoryId(args))
      }),
    ],
    [
      '__tostring',
      state.hostFunction((args) => {
        const names = directories.get(directoryId(args))
        return names == null ? 'directory (closed)' : names.map((name) => `${name}\n`).join('')
      }),
    ],
  ])
  state.rawSet(directoryMeta, '__index', directoryMeta)

  const lineBufferMeta = state.newMetatable(LINE_BUFFER, [
    [
      '__gc',
      state.hostFunction((args) => {
        lineBuffers.delete(args.userdata(1, LINE_BUFFER))
      }),
    ],
  ])

  // io.lines gives the same iterator every time, which gives nothing, as FiveM's C function does.
  const noLines = state.hostClosure(state.hostFunction(() => undefined))
  const print = state.cFunction(CFunction.print, writer)
  const standardFiles = ['stdin', 'stdout', 'stderr'].map((name) => {
    files.set(nextId, null)
    return [name, state.newUserdata(FILE_HANDLE, nextId++)] as const
  })
  const library = state.createTable([
    ['close', closeFunction],
    ['flush', state.hostFunction(() => NO_ERROR)],
    ['lines', state.hostFunction(() => noLines)],
    [
      'open',
      state.hostFunction((args) => {
        const name = untilNul(checkString(args, 1))
        const mode = decoder.decode(untilNul(optionalString(args, 2) ?? encoder.encode('r')))
        const file = host.open(decoder.decode(name), {
          write: mode.includes('a') || mode.includes('w'),
          append: mode.includes('a'),
          create: mode.includes('+'),
        })
        if (file !== undefined) return newFile(file)
        return [null, concatenate([name, encoder.encode(`: ${NO_SUCH_FILE}`)]), ENOENT]
      }),
    ],
    [
      'popen',
      state.hostFunction((args) => {
        const bytes = untilNul(checkString(args, 1))
        optionalString(args, 2)
        const failure = [null, concatenate([bytes, encoder.encode(': No error')]), 0]
        const command = decoder.decode(bytes)
        const rest = command.startsWith('dir')
          ? command.slice(3)
          : command.startsWith('ls')
            ? command.slice(2)
            : undefined
        if (rest === undefined) return failure
        const start = rest.indexOf('"')
        const end = start === -1 ? -1 : rest.indexOf('"', start + 1)
        if (end === -1) return failure
        const names = host.listCommand(rest.slice(start + 1, end))
        return names === undefined ? failure : newDirectory(names)
      }),
    ],
    ['tmpfile', state.hostFunction(() => NO_ERROR)],
    [
      'readdir',
      state.hostFunction((args) => newDirectory(host.readDirectory(checkCString(args, 1)))),
    ],
    [
      'type',
      state.hostFunction((args) => {
        checkAny(args, 1)
        const id = args.userdata(1, FILE_HANDLE)
        if (id === 0) return null
        return files.get(id) == null ? 'closed file' : 'file'
      }),
    ],
    ['write', print],
    ...standardFiles,
  ])
  for (const ref of [closeFunction, fileMeta, directoryMeta, lineBufferMeta, print]) ref.release()
  for (const [, ref] of standardFiles) ref.release()
  return library
}
