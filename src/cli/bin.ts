import { readFileSync } from 'node:fs'

import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined,
  // The build puts cfxlua.wasm next to the tool.
  cfxlua: () => WebAssembly.compile(readFileSync(new URL('cfxlua.wasm', import.meta.url))),
  now: () => performance.now(),
})
