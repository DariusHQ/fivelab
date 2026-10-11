import { describe, expect, it } from 'vitest'

import { FileTree, glob, normalizePath } from '../../src/core/engine/glob.ts'

const tree = new FileTree('resources//[cat]/a', [
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
])

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
    expect(glob(tree, 'client.lua')).toEqual({ files: ['client.lua'], found: true })
    expect(glob(tree, './client//main.lua')).toEqual({ files: ['client/main.lua'], found: true })
    expect(glob(tree, 'client/../client.lua ')).toEqual({ files: ['client.lua'], found: true })
    expect(glob(tree, 'client')).toEqual({ files: [], found: true })
  })

  it('finds no files, and says so, for values that name none', () => {
    expect(glob(tree, 'missing.lua')).toEqual({ files: [], found: false })
    expect(glob(tree, 'missing/main.lua')).toEqual({ files: [], found: false })
    expect(glob(tree, 'Client.lua')).toEqual({ files: [], found: false })
  })

  it('matches * and ? within the last part, in the order of the bytes', () => {
    expect(glob(tree, 'client/*.lua')).toEqual({
      files: ['client/B.lua', 'client/b.lua', 'client/main.lua'],
      found: true,
    })
    expect(glob(tree, 'client/?.lua').files).toEqual(['client/B.lua', 'client/b.lua'])
    expect(glob(tree, 'client/*').files).toEqual([
      'client/B.lua',
      'client/b.lua',
      'client/main.lua',
      'client/util.js',
    ])
    // A pattern that starts with * finds nothing quietly in a directory that exists.
    expect(glob(tree, 'client/*.ts')).toEqual({ files: [], found: true })
    expect(glob(tree, 'client/x*.lua')).toEqual({ files: [], found: false })
  })

  it('matches ** across directories', () => {
    expect(glob(tree, 'client/**/*.lua').files).toEqual([
      'client/B.lua',
      'client/b.lua',
      'client/deep/er/y.lua',
      'client/deep/x.lua',
      'client/main.lua',
    ])
    expect(glob(tree, 'html/**').files).toEqual(['html/css/style.css', 'html/index.html'])
    expect(glob(tree, '**.lua').files).toEqual([
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
    expect(glob(tree, 'dir*/main.lua')).toEqual({ files: ['dir/main.lua'], found: true })
    expect(glob(tree, '*/main.lua')).toEqual({ files: [], found: false })
  })

  it('keeps values of other resources, and ignores empty ones', () => {
    expect(glob(tree, '@other/file.lua')).toEqual({ files: ['@other/file.lua'], found: true })
    expect(glob(tree, '')).toEqual({ files: [], found: true })
  })

  it('takes patterns of no directory that may match nothing as found, as FiveM does', () => {
    expect(glob(tree, 'missing/*')).toEqual({ files: [], found: true })
    expect(glob(tree, 'missing/*.lua')).toEqual({ files: [], found: false })
  })
})
