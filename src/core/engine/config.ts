import type { ResourceManager } from './manager.ts'

const LINE_BREAK = new Uint8Array([0x0a])

/**
 * Adds exec to the console of a server, as FiveM's server instance adds it:
 * it runs the commands of a config file, such as server.cfg, with those
 * already in the buffer of the console, at once until one waits. Paths are
 * as readFile opens them, so @name/ is in the directory of a resource.
 */
export function addConfigCommands(manager: ResourceManager): void {
  const context = manager.console
  context.commands.add('exec', ['string'], (path) => {
    const data = manager.readFile(path)
    if (data === undefined) {
      // FiveM prints the path as a C string, which ends at a NUL.
      manager.log('cmd', `No such config file: ${path.split('\0', 1)[0]}\n`)
      return
    }
    // FiveM ends the file with a line break, so that its last command ends.
    context.addToBuffer(data)
    context.addToBuffer(LINE_BREAK)
    context.executeBuffer()
  })
}
