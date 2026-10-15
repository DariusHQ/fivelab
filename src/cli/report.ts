import { join, relative, sep } from 'node:path'

import type { Failure, FileResult, OutputLine, TestResult } from '../runner/index.ts'

/** Where a reporter writes, and how. */
export interface ReportHost {
  /** The directory of the project, which the paths of test files are relative to. */
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: (text: string) => void
  /** Whether what it writes may have colors. */
  readonly color: boolean
}

const PASSED = String.fromCodePoint(0x2713)
const FAILED = String.fromCodePoint(0xd7)
const SKIPPED = String.fromCodePoint(0x2193)

/** What became of a test file: it failed if it did not load, had no tests or had one that failed. */
type FileStatus = 'passed' | 'failed' | 'skipped'

/**
 * Writes what became of test files as they ran, then the failures, with
 * where they failed and what the processes printed, then how many passed
 * and failed. On GitHub Actions, it writes the failures as annotations too.
 */
export class Reporter {
  readonly #host: ReportHost
  readonly #files = { failed: 0, passed: 0, skipped: 0 }
  readonly #tests = { failed: 0, passed: 0, skipped: 0 }
  /** What to write of each failure once the files ran. */
  readonly #details: string[] = []

  constructor(host: ReportHost) {
    this.#host = host
  }

  /** Writes what became of a test file and its tests. */
  file(result: FileResult): void {
    const { path, tests } = result
    for (const test of tests) this.#tests[test.status]++
    const failure = result.failure ?? (tests.length === 0 ? noTests : undefined)
    const status = fileStatus(result, failure)
    this.#files[status]++
    const counted = failure === undefined ? `(${countTests(tests)})` : '(did not load)'
    this.#write(`${this.#mark(status)} ${path} ${this.#dim(counted)}\n`)
    for (const test of tests.filter(({ status }) => status === 'failed')) {
      this.#write(`   ${this.#mark('failed')} ${test.names.join(' > ')}\n`)
    }
    if (failure !== undefined) this.#fail(path, undefined, failure, result.output)
    for (const test of tests) {
      for (const failed of test.failures) this.#fail(path, test, failed, test.output)
    }
  }

  /** Writes the failures and how many passed and failed, and returns the exit code: 1 if anything failed. */
  end(duration: number): number {
    for (const detail of this.#details) this.#write(`\n${detail}`)
    this.#write(`\nTest files: ${countOf(this.#files)}\n`)
    this.#write(`Tests: ${countOf(this.#tests)}\n`)
    this.#write(`Duration: ${(duration / 1000).toFixed(2)} s\n`)
    return this.#files.failed > 0 ? 1 : 0
  }

  /** Keeps what to write of a failure of the test file at `path`, or of its `test`, and writes its annotation. */
  #fail(
    path: string,
    test: TestResult | undefined,
    failure: Failure,
    output: readonly OutputLine[],
  ) {
    const title = test === undefined ? path : `${path} > ${test.names.join(' > ')}`
    const message = failure.message.replaceAll(`@fiverunner/${path}`, path)
    const line = failure.frames[0]?.line ?? lineIn(failure.message, path)
    const lines = [this.#red(`Failed: ${title}`), `  ${message.replaceAll('\n', '\n  ')}`]
    for (const frame of failure.frames) {
      lines.push(
        `    at ${path}:${frame.line}${frame.name === undefined ? '' : ` (${frame.name})`}`,
      )
    }
    const shown = output.filter((line) => !routine(line))
    if (shown.length > 0) lines.push('  Output:', ...shown.map((line) => `    ${showLine(line)}`))
    this.#details.push(`${lines.join('\n')}\n`)
    if (this.#host.env.GITHUB_ACTIONS === 'true') {
      this.#write(annotation(this.#workspacePath(path), line, title, message))
    }
  }

  /** The path of a test file in the workspace of GitHub Actions, which annotations name files by. */
  #workspacePath(path: string): string {
    const { cwd, env } = this.#host
    const workspace = env.GITHUB_WORKSPACE
    return workspace === undefined
      ? path
      : relative(workspace, join(cwd, path)).split(sep).join('/')
  }

  #mark(status: FileStatus): string {
    if (status === 'passed') return this.#paint(32, PASSED)
    return status === 'failed' ? this.#red(FAILED) : this.#paint(33, SKIPPED)
  }

  #red(text: string): string {
    return this.#paint(31, text)
  }

  #dim(text: string): string {
    return this.#host.color ? `\x1b[2m${text}\x1b[22m` : text
  }

  /** Colors `text` with the ANSI color `code`, if the host shows colors. */
  #paint(code: number, text: string): string {
    return this.#host.color ? `\x1b[${code}m${text}\x1b[39m` : text
  }

  #write(text: string): void {
    this.#host.stdout(text)
  }
}

/** What a test file with no tests fails with. */
const noTests: Failure = { message: 'the test file has no tests', frames: [] }

function fileStatus(result: FileResult, failure: Failure | undefined): FileStatus {
  if (failure !== undefined || result.tests.some(({ status }) => status === 'failed'))
    return 'failed'
  return result.tests.every(({ status }) => status === 'skipped') ? 'skipped' : 'passed'
}

/** How many tests a file has, and how many of them failed and were skipped. */
function countTests(tests: readonly TestResult[]): string {
  const failed = tests.filter(({ status }) => status === 'failed').length
  const skipped = tests.filter(({ status }) => status === 'skipped').length
  const parts = [`${tests.length} ${tests.length === 1 ? 'test' : 'tests'}`]
  if (failed > 0) parts.push(`${failed} failed`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  return parts.join(', ')
}

/** How many failed, passed and were skipped, but none of what there were none of, and how many in all. */
function countOf(counts: Readonly<Record<FileStatus, number>>): string {
  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
  return `${parts.join(', ')} (${counts.failed + counts.passed + counts.skipped})`
}

/** The line of the test file at `path` that a message that Lua wrote begins with, if it does. */
function lineIn(message: string, path: string): number | undefined {
  const at = `@fiverunner/${path}:`
  return message.startsWith(at) ? Number.parseInt(message.slice(at.length), 10) : undefined
}

/**
 * Whether a line only tells what servers and clients do with resources as
 * they start: scan for them, download, start and stop them.
 */
function routine({ kind, channel, text }: OutputLine): boolean {
  if (kind !== 'console') return false
  switch (channel) {
    case 'citizen-scripting-core':
      return text.startsWith('Creating script environments for ')
    case 'citizen-legacy-net-resources':
      return text.startsWith('Required resources: ')
    case 'resources':
      return /^(Started resource |Stopping resource |\^2)/.test(text)
    default:
      return false
  }
}

/** A line of output as the report shows it: without colors, and with the client that wrote it. */
function showLine({ process, kind, channel, text }: OutputLine): string {
  const by = process === 'server' ? '' : `${process} `
  const what = kind === 'warning' ? 'Lua warning: ' : kind === 'diagnostic' ? 'FiveRunner: ' : ''
  return `${by}[${channel}] ${what}${text.replace(/\^\d/g, '')}`
}

/** An error annotation for GitHub Actions, as its workflow commands write them. */
function annotation(
  file: string,
  line: number | undefined,
  title: string,
  message: string,
): string {
  const properties = [`file=${property(file)}`]
  if (line !== undefined) properties.push(`line=${line}`)
  properties.push(`title=${property(title)}`)
  return `::error ${properties.join(',')}::${data(message)}\n`
}

/** The data of a workflow command, escaped. */
function data(text: string): string {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

/** A property of a workflow command, escaped. */
function property(text: string): string {
  return data(text).replaceAll(':', '%3A').replaceAll(',', '%2C')
}
