import { describe, expect, it } from 'vitest'

import { MemoryFileSystem } from '../../src/core/engine/files.ts'
import { glob as globFiles, normalizePath } from '../../src/core/engine/glob.ts'

const root = 'resources//[cat]/a'
const files = new MemoryFileSystem(
  Object.fromEntries(
    [
      'fxmanifest.lua',
      'client.lua',
      'client/main.lua',
      'client/B.lua',
      'client/b.lua',
      'client/util.js',
      'client/deep/x.lua',
      'client/deep/er/y.lua',
      'dir/main.lua',
      'dir2/main.lua',
      'html/index.html',
      'html/css/style.css',
    ].map((path) => [`${root}/${path}`, '']),
  ),
)

/** Globs a value as the resource at `root` does. */
function glob(value: string) {
  return globFiles(files, root, value)
}

describe('normalizePath', () => {
  it('normalizes paths as FiveM does', () => {
    expect(normalizePath('a//b/./c')).toBe('a/b/c')
    expect(normalizePath('a\\b\\c')).toBe('a/b/c')
    expect(normalizePath('a/b/../c/')).toBe('a/c')
    expect(normalizePath('../a/../../b')).toBe('../../b')
    expect(normalizePath('  a/b  ')).toBe('a/b')
    expect(normalizePath('/a/b')).toBe('/a/b')
    expect(normalizePath('C:\\a\\..\\b')).toBe('C:/b')
  })
})

describe('glob', () => {
  it('finds the files values name, relative to the resource', () => {
    expect(glob('client.lua')).toEqual({ files: ['client.lua'], found: true })
    expect(glob('./client//main.lua')).toEqual({ files: ['client/main.lua'], found: true })
    expect(glob('client/../client.lua ')).toEqual({ files: ['client.lua'], found: true })
    expect(glob('client')).toEqual({ files: [], found: true })
  })

  it('finds no files, and says so, for values that name none', () => {
    expect(glob('missing.lua')).toEqual({ files: [], found: false })
    expect(glob('missing/main.lua')).toEqual({ files: [], found: false })
    expect(glob('Client.lua')).toEqual({ files: [], found: false })
  })

  it('matches * and ? within the last part, in the order of the bytes', () => {
    expect(glob('client/*.lua')).toEqual({
      files: ['client/B.lua', 'client/b.lua', 'client/main.lua'],
      found: true,
    })
    expect(glob('client/?.lua').files).toEqual(['client/B.lua', 'client/b.lua'])
    expect(glob('client/*').files).toEqual([
      'client/B.lua',
      'client/b.lua',
      'client/main.lua',
      'client/util.js',
    ])
    // A pattern that starts with * finds nothing quietly in a directory that exists.
    expect(glob('client/*.ts')).toEqual({ files: [], found: true })
    expect(glob('client/x*.lua')).toEqual({ files: [], found: false })
  })

  it('matches ** across directories', () => {
    expect(glob('client/**/*.lua').files).toEqual([
      'client/B.lua',
      'client/b.lua',
      'client/deep/er/y.lua',
      'client/deep/x.lua',
      'client/main.lua',
    ])
    expect(glob('html/**').files).toEqual(['html/css/style.css', 'html/index.html'])
    expect(glob('**.lua').files).toEqual([
      'client.lua',
      'client/B.lua',
      'client/b.lua',
      'client/deep/er/y.lua',
      'client/deep/x.lua',
      'client/main.lua',
      'dir/main.lua',
      'dir2/main.lua',
      'fxmanifest.lua',
    ])
  })

  it('matches only the start of a part with * when a slash follows the part, as FiveM does', () => {
    expect(glob('dir*/main.lua')).toEqual({ files: ['dir/main.lua'], found: true })
    expect(glob('*/main.lua')).toEqual({ files: [], found: false })
  })

  it('keeps values of other resources, and ignores empty ones', () => {
    expect(glob('@other/file.lua')).toEqual({ files: ['@other/file.lua'], found: true })
    expect(glob('')).toEqual({ files: [], found: true })
  })

  it('takes patterns of no directory that may match nothing as found, as FiveM does', () => {
    expect(glob('missing/*')).toEqual({ files: [], found: true })
    expect(glob('missing/*.lua')).toEqual({ files: [], found: false })
  })
})
