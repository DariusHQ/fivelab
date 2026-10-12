import { describe, expect, it } from 'vitest'

import { EVERYONE, Security } from '../../src/core/console/security.ts'

describe('Security', () => {
  it('checks everyone when code runs as no principal', () => {
    const security = new Security()
    security.addEntry(EVERYONE, 'command.help', 'allow')
    expect(security.check('command.help')).toBe(true)
    expect(security.check('command.quit')).toBe(false)
    security.runAs('resource.a', () => {
      expect(security.check('command.help')).toBe(true)
      expect(security.check('command.quit')).toBe(false)
    })
  })

  it('allows access to objects and their children', () => {
    const security = new Security()
    security.addEntry('system.console', 'command', 'allow')
    const may = (object: string) => security.checkPrincipal('system.console', object)
    expect(may('command')).toBe(true)
    expect(may('command.say')).toBe(true)
    expect(may('command.a.b')).toBe(true)
    expect(may('commands')).toBe(false)
    expect(may('webadmin')).toBe(false)
    expect(security.checkPrincipal('resource.a', 'command.say')).toBe(false)
  })

  it('lets denials trump all', () => {
    const security = new Security()
    security.addEntry('group.admin', 'command', 'allow')
    security.addEntry('group.admin', 'command.quit', 'deny')
    security.addEntry('group.admin', 'command.say', 'allow')
    security.addEntry(EVERYONE, 'command.say.loud', 'deny')
    const may = (object: string) => security.checkPrincipal('group.admin', object)
    expect(may('command.restart')).toBe(true)
    expect(may('command.quit')).toBe(false)
    expect(may('command.quit.now')).toBe(false)
    expect(may('command.say')).toBe(true)
    expect(may('command.say.loud')).toBe(false)
  })

  it('gives principals the access of those they inherit from, but not of the parents of everyone', () => {
    const security = new Security()
    security.addInheritance('identifier.license:1', 'group.admin')
    security.addInheritance('group.admin', 'group.mod')
    security.addInheritance('group.mod', 'group.admin')
    security.addInheritance(EVERYONE, 'group.user')
    security.addEntry('group.mod', 'command.kick', 'allow')
    security.addEntry('group.user', 'command.me', 'allow')
    expect(security.checkPrincipal('identifier.license:1', 'command.kick')).toBe(true)
    expect(security.checkPrincipal('group.admin', 'command.kick')).toBe(true)
    expect(security.checkPrincipal('identifier.license:2', 'command.kick')).toBe(false)
    expect(security.checkPrincipal('identifier.license:1', 'command.me')).toBe(false)
    expect(security.checkPrincipal(EVERYONE, 'command.me')).toBe(true)
    // FiveM does not look for the parents of everyone, even through those that inherit from it.
    security.addInheritance('identifier.license:3', EVERYONE)
    expect(security.checkPrincipal('identifier.license:3', 'command.me')).toBe(false)
    security.removeInheritance('Group.Admin', 'GROUP.MOD')
    expect(security.checkPrincipal('identifier.license:1', 'command.kick')).toBe(false)
  })

  it('lowercases principals and objects as C does, so only ASCII letters', () => {
    const security = new Security()
    security.addEntry('Resource.A', 'Command.Say', 'allow')
    security.addEntry('resource.É', 'command.say', 'allow')
    expect(security.entries).toEqual([
      { principal: 'resource.a', object: 'command.say', access: 'allow' },
      { principal: 'resource.É', object: 'command.say', access: 'allow' },
    ])
    expect(security.checkPrincipal('RESOURCE.a', 'COMMAND.SAY')).toBe(true)
    expect(security.checkPrincipal('resource.é', 'command.say')).toBe(false)
    expect(security.runAs('Resource.A', () => security.principals)).toEqual(['resource.a'])
  })

  it('runs code as principals, the innermost first', () => {
    const security = new Security()
    security.addEntry('resource.a', 'command.a', 'allow')
    security.addEntry('system.console', 'command.b', 'allow')
    expect(() =>
      security.runAs('system.console', () =>
        security.runAs('resource.a', () => {
          expect(security.principals).toEqual(['resource.a', 'system.console'])
          expect(security.check('command.a')).toBe(true)
          expect(security.check('command.b')).toBe(true)
          expect(security.check('command.c')).toBe(false)
          throw new Error('stop')
        }),
      ),
    ).toThrow('stop')
    expect(security.principals).toEqual([])
    expect(security.check('command.a')).toBe(false)
  })

  it('orders entries by object and inheritances by child, as C++ orders strings', () => {
    const security = new Security()
    const high = String.fromCodePoint(0xffff)
    const astral = String.fromCodePoint(0x10000)
    security.addEntry('a', astral, 'allow')
    security.addEntry('b', high, 'deny')
    security.addEntry('c', 'x', 'allow')
    security.addEntry('d', 'x', 'deny')
    security.addEntry('e', 'w', 'allow')
    expect(security.entries.map((entry) => entry.principal)).toEqual(['e', 'c', 'd', 'b', 'a'])
    security.addInheritance('y', 'p1')
    security.addInheritance('x', 'p2')
    security.addInheritance('y', 'p3')
    expect(security.inheritances).toEqual([
      { child: 'x', parent: 'p2' },
      { child: 'y', parent: 'p1' },
      { child: 'y', parent: 'p3' },
    ])
  })

  it('removes the entries of a principal for an object with an access', () => {
    const security = new Security()
    security.addEntry('a', 'x', 'allow')
    security.addEntry('a', 'x', 'allow')
    security.addEntry('a', 'x', 'deny')
    security.addEntry('b', 'x', 'allow')
    security.addEntry('a', 'y', 'allow')
    security.removeEntry('A', 'X', 'allow')
    expect(security.entries).toEqual([
      { principal: 'a', object: 'x', access: 'deny' },
      { principal: 'b', object: 'x', access: 'allow' },
      { principal: 'a', object: 'y', access: 'allow' },
    ])
  })
})
