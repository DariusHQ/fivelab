import { FIVEM_LIBS, type CfxLuaExports, type CfxLuaHostImports, type Ptr } from './abi.ts'
import { LuaFatalError, isStackOverflow } from './errors.ts'
import { LuaState } from './state.ts'

export type OutputStream = 'stdout' | 'stderr'

export interface LuaRuntimeOptions {
  /**
   * Receives what the module writes to stdout and stderr, in pieces that need
   * not end at line breaks. Defaults to the console, one line at a time. It
   * must not call into Lua.
   */
  readonly output?: (stream: OutputStream, text: string) => void
  /** Wall-clock time in milliseconds since the epoch, used by time() in C. */
  readonly now?: () => number
}

export interface LuaStateOptions {
  /** Libraries to open, as LuaLib bits. Defaults to the set FiveM opens. */
  readonly libs?: number
  /** Allocation limit in bytes; 0 means unlimited. */
  readonly memoryLimit?: number
  /**
   * Receives each warning: what warn() reports and errors in finalizers.
   * Defaults to the runtime output, as "Lua warning: ..." on stderr. It must
   * not call into Lua.
   */
  readonly onWarning?: (message: string) => void
}

const WASI_EBADF = 8
const WASI_ENOSYS = 52
const WASI_ESPIPE = 70

/** Scratch space for strings passed into the module; larger ones get their own block. */
const SCRATCH_MIN = 4096
const SCRATCH_MAX = 1024 * 1024

/** Converts milliseconds to WASI nanoseconds without losing precision to doubles. */
function nanoseconds(ms: number): bigint {
  const whole = Math.trunc(ms)
  return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Rethrows outside the current call stack, so the error is reported but cannot unwind it. */
function reportLater(error: unknown): void {
  queueMicrotask(() => {
    throw error
  })
}

/** Prints to the console one line at a time, holding back a line until it ends. */
function consoleOutput(): (stream: OutputStream, text: string) => void {
  const pending = { stdout: '', stderr: '' }
  return (stream, text) => {
    const lines = (pending[stream] + text).split('\n')
    pending[stream] = lines.pop() ?? ''
    for (const line of lines) {
      if (stream === 'stdout') console.log(line)
      else console.error(line)
    }
  }
}

/**
 * One instance of cfxlua.wasm. Like a FiveM process, it hosts any number of
 * Lua states that share a heap, and process-wide counters such as the one
 * behind tostring() of tables.
 *
 * A trap, a stack overflow inside the module or an exception escaping it
 * leaves the shared heap in an unknown state, so the runtime crashes: every
 * state in it fails from then on with the same LuaFatalError.
 */
export class LuaRuntime {
  #exports!: CfxLuaExports
  #memory!: WebAssembly.Memory
  #heap = new Uint8Array(0)
  #view = new DataView(new ArrayBuffer(0))
  readonly #encoder = new TextEncoder()
  readonly #decoder = new TextDecoder()
  readonly #streams = [new TextDecoder(), new TextDecoder()]
  readonly #output: (stream: OutputStream, text: string) => void
  readonly #now: () => number
  readonly #states = new Map<number, LuaState>()
  #nextStateId = 1
  #scratch: Ptr = 0
  #scratchSize = 0
  #scratchBusy = false
  #out: Ptr = 0
  #stackBase: Ptr = 0
  #importDepth = 0
  #handlerDepth = 0
  #crashed: LuaFatalError | undefined

  private constructor(options: LuaRuntimeOptions) {
    this.#output = options.output ?? consoleOutput()
    this.#now = options.now ?? Date.now
  }

  static async create(
    module: WebAssembly.Module,
    options: LuaRuntimeOptions = {},
  ): Promise<LuaRuntime> {
    const runtime = new LuaRuntime(options)
    const instance = await WebAssembly.instantiate(module, runtime.#imports())
    runtime.#init(instance)
    return runtime
  }

  get exports(): CfxLuaExports {
    return this.#exports
  }

  /** The error that crashed this runtime, if it has crashed. */
  get crashed(): LuaFatalError | undefined {
    return this.#crashed
  }

  get heap(): Uint8Array {
    if (this.#heap.buffer !== this.#memory.buffer) this.#refreshViews()
    return this.#heap
  }

  get view(): DataView {
    if (this.#view.buffer !== this.#memory.buffer) this.#refreshViews()
    return this.#view
  }

  /** A 16-byte block for out-parameters. */
  get out(): Ptr {
    return this.#out
  }

  newState(options: LuaStateOptions = {}): LuaState {
    this.checkEnter()
    const id = this.#nextStateId++
    const L = this.#exports.fr_newstate(id)
    if (L === 0) throw new RangeError('Not enough memory to create a Lua state')
    const state = new LuaState(this, id, L, options.onWarning)
    this.#states.set(id, state)
    try {
      if (options.memoryLimit !== undefined) state.memoryLimit = options.memoryLimit
      state.openLibs(options.libs ?? FIVEM_LIBS)
    } catch (error) {
      state.close()
      throw error
    }
    return state
  }

  /** Throws when JavaScript may not call into the module: it crashed, or a handler is running. */
  checkEnter(): void {
    if (this.#crashed) throw this.#crashed
    if (this.#handlerDepth > 0) {
      throw new Error('Cannot call into Lua from an output or warning handler')
    }
  }

  /** Called by LuaState.close. */
  forget(id: number): void {
    this.#states.delete(id)
  }

  /** Marks the runtime as crashed and returns the error that reports it. */
  crash(cause: unknown): LuaFatalError {
    this.#crashed ??= new LuaFatalError(`Lua runtime crashed: ${describe(cause)}`, 'runtime', {
      cause,
    })
    return this.#crashed
  }

  /**
   * Translates an exception thrown while JavaScript was calling into the
   * module. Lua errors unwinding to an enclosing Lua frame pass through;
   * anything that unwound frames nothing can recover crashes the runtime.
   * Errors thrown by JavaScript between calls are returned unchanged.
   */
  escaped(error: unknown): unknown {
    if (this.#crashed) return this.#crashed
    if (error instanceof WebAssembly.Exception) {
      return this.#importDepth > 0 ? error : this.crash(error)
    }
    if (error instanceof LuaFatalError) {
      if (this.#importDepth === 0) this.#exports.fr_stackrestore(this.#stackBase)
      return error
    }
    if (error instanceof WebAssembly.RuntimeError || isStackOverflow(error)) {
      return this.crash(error)
    }
    return error
  }

  /** Writes to the output like the module's stdout and stderr. Never throws. */
  write(stream: OutputStream, text: string): void {
    this.notify(() => this.#output(stream, text))
  }

  /**
   * Runs an output or warning handler while Lua may be running below it. The
   * handler cannot call into Lua, and what it throws is reported
   * asynchronously instead of unwinding through the module.
   */
  notify(handler: () => void): void {
    this.#handlerDepth++
    try {
      handler()
    } catch (error) {
      reportLater(error)
    } finally {
      this.#handlerDepth--
    }
  }

  readString(ptr: Ptr, length: number): string {
    return this.#decoder.decode(this.heap.subarray(ptr, ptr + length))
  }

  readBytes(ptr: Ptr, length: number): Uint8Array {
    return this.heap.slice(ptr, ptr + length)
  }

  /** Copies `text` into module memory as UTF-8 for the duration of `use`. */
  withString<T>(text: string, use: (ptr: Ptr, length: number) => T): T {
    const capacity = text.length * 3
    if (!this.#scratchBusy && this.#ensureScratch(capacity)) {
      const { written } = this.#encoder.encodeInto(
        text,
        this.heap.subarray(this.#scratch, this.#scratch + capacity),
      )
      return this.#useScratch(written, use)
    }
    return this.withBytes(this.#encoder.encode(text), use)
  }

  /** Copies `bytes` into module memory for the duration of `use`. */
  withBytes<T>(bytes: Uint8Array, use: (ptr: Ptr, length: number) => T): T {
    if (!this.#scratchBusy && this.#ensureScratch(bytes.length)) {
      this.heap.set(bytes, this.#scratch)
      return this.#useScratch(bytes.length, use)
    }
    const ptr = this.alloc(bytes.length)
    try {
      this.heap.set(bytes, ptr)
      return use(ptr, bytes.length)
    } finally {
      this.#exports.free(ptr)
    }
  }

  /**
   * Copies a chunk with its name and mode into one block for fr_load. The
   * parser can run Lua code (finalizers) while it reads, so the chunk never
   * lives in the shared scratch space.
   */
  withChunk<T>(
    chunk: Uint8Array,
    name: string,
    mode: string,
    use: (chunk: Ptr, length: number, name: Ptr, mode: Ptr) => T,
  ): T {
    const nameBytes = this.#encoder.encode(`${name}\0`)
    const modeBytes = this.#encoder.encode(`${mode}\0`)
    const ptr = this.alloc(chunk.length + nameBytes.length + modeBytes.length)
    try {
      const heap = this.heap
      heap.set(chunk, ptr)
      heap.set(nameBytes, ptr + chunk.length)
      heap.set(modeBytes, ptr + chunk.length + nameBytes.length)
      return use(ptr, chunk.length, ptr + chunk.length, ptr + chunk.length + nameBytes.length)
    } finally {
      this.#exports.free(ptr)
    }
  }

  alloc(size: number): Ptr {
    const ptr = this.#exports.malloc(Math.max(size, 1))
    if (ptr === 0) throw new RangeError('The Lua runtime is out of memory')
    return ptr >>> 0
  }

  #ensureScratch(size: number): boolean {
    if (size <= this.#scratchSize) return true
    if (size > SCRATCH_MAX) return false
    let next = Math.max(this.#scratchSize * 2, SCRATCH_MIN)
    while (next < size) next *= 2
    const ptr = this.alloc(next)
    if (this.#scratch !== 0) this.#exports.free(this.#scratch)
    this.#scratch = ptr
    this.#scratchSize = next
    return true
  }

  #useScratch<T>(length: number, use: (ptr: Ptr, length: number) => T): T {
    this.#scratchBusy = true
    try {
      return use(this.#scratch, length)
    } finally {
      this.#scratchBusy = false
    }
  }

  #refreshViews(): void {
    this.#heap = new Uint8Array(this.#memory.buffer)
    this.#view = new DataView(this.#memory.buffer)
  }

  #init(instance: WebAssembly.Instance): void {
    this.#exports = instance.exports as unknown as CfxLuaExports
    this.#memory = this.#exports.memory
    this.#refreshViews()
    this.#exports._initialize()
    this.#stackBase = this.#exports.fr_stacksave()
    this.#out = this.alloc(16)
    this.#ensureScratch(SCRATCH_MIN)
  }

  #state(vm: number): LuaState {
    const state = this.#states.get(vm)
    if (state === undefined) throw this.crash(new Error(`Call from unknown Lua state ${vm}`))
    return state
  }

  #imports(): WebAssembly.Imports {
    const fiverunner = {
      call: (vm, L, fn, nargs) => {
        if (this.#crashed) throw this.#crashed
        const state = this.#state(vm)
        this.#importDepth++
        try {
          return state.dispatch(L >>> 0, fn, nargs)
        } finally {
          this.#importDepth--
        }
      },
      hook: (vm, L) => {
        if (this.#crashed) throw this.#crashed
        const state = this.#state(vm)
        this.#importDepth++
        try {
          return state.hook(L >>> 0)
        } finally {
          this.#importDepth--
        }
      },
      panic: (vm, L) => {
        throw this.#state(vm).panic(L >>> 0)
      },
      warn: (vm, msg, len, tocont) => {
        const ptr = msg >>> 0
        this.#states.get(vm)?.warn(this.heap.subarray(ptr, ptr + (len >>> 0)), tocont !== 0)
      },
    } satisfies CfxLuaHostImports
    return {
      fiverunner,
      env: {
        emscripten_notify_memory_growth: (): void => this.#refreshViews(),
        __syscall_dup3: (): number => -WASI_ENOSYS,
      },
      wasi_snapshot_preview1: {
        fd_write: (fd: number, iovs: Ptr, count: number, written: Ptr): number => {
          if (fd !== 1 && fd !== 2) return WASI_EBADF
          const view = this.view
          let total = 0
          let text = ''
          for (let i = 0; i < count; i++) {
            const ptr = view.getUint32(iovs + i * 8, true)
            const length = view.getUint32(iovs + i * 8 + 4, true)
            text += this.#streams[fd - 1]!.decode(this.heap.subarray(ptr, ptr + length), {
              stream: true,
            })
            total += length
          }
          view.setUint32(written, total, true)
          if (text !== '') this.write(fd === 1 ? 'stdout' : 'stderr', text)
          return 0
        },
        fd_read: (fd: number, _iovs: Ptr, _count: number, read: Ptr): number => {
          if (fd !== 0) return WASI_EBADF
          this.view.setUint32(read, 0, true)
          return 0
        },
        fd_seek: (fd: number): number => (fd <= 2 ? WASI_ESPIPE : WASI_EBADF),
        fd_close: (fd: number): number => (fd <= 2 ? 0 : WASI_EBADF),
        clock_time_get: (clock: number, _precision: bigint, time: Ptr): number => {
          const ms = clock === 0 ? this.#now() : performance.now()
          this.view.setBigUint64(time, nanoseconds(ms), true)
          return 0
        },
      },
    }
  }
}
