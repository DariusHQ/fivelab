import packageJson from '../../package.json' with { type: 'json' }

/** What the command line tool writes to. */
export interface CliHost {
  readonly stdout: (text: string) => void
  readonly stderr: (text: string) => void
}

const USAGE = `Usage: fiverunner [options]

Options:
  -h, --help     Show this help
  -v, --version  Show the version of FiveRunner
`

/**
 * Runs the command line tool with `args`, the arguments after its name,
 * and returns its exit code: 0 once it did what they ask, and 2 if they
 * make no sense to it.
 */
export async function main(args: readonly string[], host: CliHost): Promise<number> {
  const [first] = args
  if (args.length <= 1 && (first === undefined || first === '-h' || first === '--help')) {
    host.stdout(`FiveRunner ${packageJson.version}\n\n${USAGE}`)
    return 0
  }
  if (args.length === 1 && (first === '-v' || first === '--version')) {
    host.stdout(`${packageJson.version}\n`)
    return 0
  }
  host.stderr(`fiverunner: unknown arguments: ${args.join(' ')}\n\n${USAGE}`)
  return 2
}
