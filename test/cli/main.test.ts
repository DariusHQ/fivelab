import { describe, expect, it } from 'vitest'

import packageJson from '../../package.json' with { type: 'json' }
import { main } from '../../src/cli/main.ts'
import { cfxlua } from '../lua/helpers.ts'

/** Runs the command line tool with `args`, and returns its exit code with what it wrote. */
async function run(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await main(args, {
    cwd: process.cwd(),
    env: {},
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    color: false,
    cfxlua,
    now: () => 0,
  })
  return { code, stdout, stderr }
}

const usage = `Usage: fiverunner <command> [options]

Commands:
  test [paths...]  Run the tests of the project in this directory

Options:
  -h, --help       Show this help
  -v, --version    Show the version of FiveRunner
`

describe('The command line tool', () => {
  it('shows its version', async () => {
    const shown = { code: 0, stdout: `${packageJson.version}\n`, stderr: '' }
    expect([await run('-v'), await run('--version')]).toEqual([shown, shown])
  })

  it('shows its help, as it does without arguments', async () => {
    const shown = { code: 0, stdout: `FiveRunner ${packageJson.version}\n\n${usage}`, stderr: '' }
    expect([await run(), await run('-h'), await run('--help')]).toEqual([shown, shown, shown])
  })

  it('fails with its usage for arguments that make no sense to it', async () => {
    const failed = (args: string) => ({
      code: 2,
      stdout: '',
      stderr: `fiverunner: unknown arguments: ${args}\n\n${usage}`,
    })
    expect([
      await run('nope'),
      await run('--help', 'more'),
      await run('--version', 'more'),
    ]).toEqual([failed('nope'), failed('--help more'), failed('--version more')])
  })
})
