import { isAbsolute, relative, resolve, sep } from 'node:path'

import type { FileSource } from '../core/engine/index.ts'
import { compareUtf8 } from '../core/libc.ts'
import { findTestFiles, openProject, type LocalProject } from '../node/project.ts'
import { runFile, type FileResult } from '../runner/index.ts'
import type { CliHost } from './main.ts'
import { Reporter } from './report.ts'

const USAGE = `Usage: fiverunner test [paths...]

Runs the tests of the project in this directory: the *.test.lua files in
the paths given, or in the whole project. The project is a resource when
the directory has an fxmanifest.lua or a __resource.lua, and a server when
it has a resources directory, whose server.cfg, if there is one, starts
the resources of the server.

Options:
  -h, --help  Show this help
`

/** What the arguments of the command ask for that the project does not have. */
class UsageError extends Error {}

/**
 * Runs the tests of the project in the directory that the tool runs in,
 * and returns the exit code: 0 if they passed, 1 if any failed, or if
 * there were none, and 2 if the arguments make no sense to it, or there
 * is no project.
 */
export async function test(args: readonly string[], host: CliHost): Promise<number> {
  if (args.length === 1 && (args[0] === '-h' || args[0] === '--help')) {
    host.stdout(USAGE)
    return 0
  }
  const option = args.find((arg) => arg.startsWith('-'))
  if (option !== undefined) {
    host.stderr(`fiverunner: unknown option ${option}\n\n${USAGE}`)
    return 2
  }
  const project = openProject(host.cwd)
  if (project === undefined) {
    host.stderr(
      'fiverunner: there is no FiveM project here: a resource has an fxmanifest.lua or a __resource.lua, and a server a resources directory\n',
    )
    return 2
  }
  let paths: string[]
  try {
    paths = testFiles(project, args, host.cwd)
  } catch (error) {
    if (!(error instanceof UsageError)) throw error
    host.stderr(`fiverunner: ${error.message}\n`)
    return 2
  }
  if (paths.length === 0) {
    host.stderr('fiverunner: there are no test files, whose names end in .test.lua\n')
    return 1
  }
  const start = host.now()
  const cfxlua = await host.cfxlua()
  const reporter = new Reporter(host)
  for (const path of paths) reporter.file(await run(project, path, cfxlua))
  return reporter.end(host.now() - start)
}

/** Runs the test file at `path` in the project, which fails with what the runner threw, if it did. */
async function run(
  project: LocalProject,
  path: string,
  cfxlua: WebAssembly.Module,
): Promise<FileResult> {
  try {
    return await runFile({ path, source: project.source.read(path) }, { cfxlua, project })
  } catch (error) {
    const message = `FiveRunner failed to run the file: ${error instanceof Error ? error.message : String(error)}`
    return { path, tests: [], failure: { message, frames: [] }, output: [] }
  }
}

/**
 * The test files in `paths`, which are relative to `cwd`, the directory
 * of the project, or in the whole project without paths, in the order of
 * their bytes.
 */
function testFiles(project: LocalProject, paths: readonly string[], cwd: string): string[] {
  const { source } = project
  if (paths.length === 0) return findTestFiles(source)
  const found = new Set<string>()
  for (const given of paths) {
    const path = relative(cwd, resolve(cwd, given)).split(sep).join('/')
    if (path === '..' || path.startsWith('../') || isAbsolute(path)) {
      throw new UsageError(`${given} is not in the project`)
    }
    const kind = kindOf(source, path)
    if (kind === undefined) throw new UsageError(`there is no ${given}`)
    if (kind === 'directory') {
      for (const file of findTestFiles(source, path)) found.add(file)
    } else if (path.endsWith('.test.lua')) {
      found.add(path)
    } else {
      throw new UsageError(`${given} is no test file, as the names of test files end in .test.lua`)
    }
  }
  return [...found].sort(compareUtf8)
}

/** Whether there is a file or a directory at `path` in a source, if there is anything. */
function kindOf(source: FileSource, path: string): 'file' | 'directory' | undefined {
  if (path === '') return 'directory'
  const slash = path.lastIndexOf('/')
  const parent = slash === -1 ? '' : path.slice(0, slash)
  if (kindOf(source, parent) !== 'directory') return undefined
  const entry = source.list(parent).find(({ name }) => name === path.slice(slash + 1))
  if (entry === undefined) return undefined
  return entry.directory ? 'directory' : 'file'
}
