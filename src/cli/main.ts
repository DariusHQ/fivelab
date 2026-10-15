import packageJson from '../../package.json' with { type: 'json' }
import { test } from './test.ts'

/** What the command line tool runs with: where it runs, what it writes to, and cfxlua.wasm. */
export interface CliHost {
  /** The directory that the tool runs in, whose project it tests. */
  readonly cwd: string
  /** The variables of its environment, such as GITHUB_ACTIONS. */
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
  /** Whether what it writes to stdout may have colors. */
  readonly color: boolean
  /** Compiles cfxlua.wasm. */
  readonly cfxlua: () => Promise<WebAssembly.Module>
  /** Milliseconds by a clock that only moves on, which times the run. */
  readonly now: () => number
}

const USAGE = `Usage: fiverunner <command> [options]

Commands:
  test [paths...]  Run the tests of the project in this directory

Options:
  -h, --help       Show this help
  -v, --version    Show the version of FiveRunner
`

/**
 * Runs the command line tool with `args`, the arguments after its name,
 * and returns its exit code: 0 once it did what they ask, 1 when tests
 * failed, and 2 if they make no sense to it.
 */
export async function main(args: readonly string[], host: CliHost): Promise<number> {
  const [first, ...rest] = args
  if (first === 'test') return test(rest, host)
  if (rest.length === 0 && (first === undefined || first === '-h' || first === '--help')) {
    host.stdout(`FiveRunner ${packageJson.version}\n\n${USAGE}`)
    return 0
  }
  if (rest.length === 0 && (first === '-v' || first === '--version')) {
    host.stdout(`${packageJson.version}\n`)
    return 0
  }
  host.stderr(`fiverunner: unknown arguments: ${args.join(' ')}\n\n${USAGE}`)
  return 2
}
