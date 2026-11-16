import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAssetStore } from '@vis/assets'
import { eq, openSpaceDb, spaceSchema as s } from '@vis/storage'
import { resolveAssetPaths } from './asset-paths'

let dir: string
let host: Parameters<typeof resolveAssetPaths>[0]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vis-asset-paths-'))
  let clock = 1000
  host = { db: openSpaceDb(':memory:'), assets: createAssetStore({ blobsDir: join(dir, 'blobs'), now: () => ++clock }) }
})
afterEach(() => {
  host.db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

async function register(text = 'image', assetId?: string, kind: 'image' | 'video' | 'audio' = 'image') {
  const staged = await host.assets.stageBytes(Buffer.from(text))
  return { ...host.assets.registerVersion(host.db, { staged, kind, mime: `${kind}/${kind === 'video' ? 'mp4' : 'png'}`, origin: 'import', displayName: 'Project image', ...(assetId ? { assetId } : {}) }), path: host.assets.blobPath(staged.hash) }
}

it('resolves multiple distinct and repeated hashes in one query, keeping the newest match for each', async () => {
  const first = await register('first')
  const second = await register('second')
  const latest = await register('first', first.assetId)
  const select = vi.spyOn(host.db, 'select')
  const result = resolveAssetPaths(host, { paths: [first.path, second.path, first.path, join(dir, 'missing')] })
  expect(select).toHaveBeenCalledTimes(1)
  expect(result.results.map(asset => asset?.assetVersionId ?? null)).toEqual([latest.assetVersionId, second.assetVersionId, latest.assetVersionId, null])
  select.mockRestore()
})

it('skips the database query when no path is a valid canonical blob', () => {
  const select = vi.spyOn(host.db, 'select')
  expect(resolveAssetPaths(host, { paths: [join(dir, 'missing')] })).toEqual({ results: [null] })
  expect(select).not.toHaveBeenCalled()
  select.mockRestore()
})

it('resolves registered blob paths to IDs in input order without returning paths or invented frame provenance', async () => {
  const image = await register()
  const video = await register('video', undefined, 'video')
  expect(resolveAssetPaths(host, { paths: [video.path, join(dir, 'missing'), image.path, video.path] })).toEqual({ results: [
    { assetId: video.assetId, assetVersionId: video.assetVersionId, kind: 'video', displayName: 'Project image' },
    null,
    { assetId: image.assetId, assetVersionId: image.assetVersionId, kind: 'image', displayName: 'Project image' },
    { assetId: video.assetId, assetVersionId: video.assetVersionId, kind: 'video', displayName: 'Project image' },
  ] })
  expect(resolveAssetPaths(host, { paths: [image.path] }).results[0]?.assetId).toBe(host.assets.getVersion(host.db, image.assetVersionId)!.assetId)
})

it('chooses the newest version sharing a blob and skips versions belonging to archived assets', async () => {
  const first = await register()
  const next = await register('image', first.assetId)
  const newest = await register()
  expect(resolveAssetPaths(host, { paths: [first.path] }).results[0]?.assetVersionId).toBe(newest.assetVersionId)
  host.db.update(s.assets).set({ archivedAt: 2000 }).where(eq(s.assets.id, newest.assetId)).run()
  expect(resolveAssetPaths(host, { paths: [first.path] }).results[0]?.assetVersionId).toBe(next.assetVersionId)
  host.db.update(s.assets).set({ archivedAt: 2000 }).where(eq(s.assets.id, first.assetId)).run()
  expect(resolveAssetPaths(host, { paths: [first.path] })).toEqual({ results: [null] })
})

it('returns null for outside paths, missing blobs, parent traversal, wrong shards, non-hex names and unregistered hashes', async () => {
  const image = await register()
  const hash = host.assets.getVersion(host.db, image.assetVersionId)!.blobHash
  const outside = join(dir, hash)
  copyFileSync(image.path, outside)
  const nonHex = join(dirname(image.path), 'g'.repeat(64))
  copyFileSync(image.path, nonHex)
  const wrongShard = join(host.assets.blobsDir, 'wrong', hash)
  mkdirSync(dirname(wrongShard))
  copyFileSync(image.path, wrongShard)
  const unregistered = join(dirname(image.path), `${hash.slice(0, 2)}${'0'.repeat(62)}`)
  copyFileSync(image.path, unregistered)
  const traversal = `${dirname(image.path)}${sep}..${sep}..${sep}${hash}`
  rmSync(image.path)
  expect(resolveAssetPaths(host, { paths: [outside, image.path, traversal, wrongShard, nonHex, unregistered] })).toEqual({ results: [null, null, null, null, null, null] })
})

it('returns null for a symlink inside the blob directory whose realpath points outside', async () => {
  const image = await register()
  const outside = join(dir, 'outside.png')
  writeFileSync(outside, 'outside')
  rmSync(image.path)
  symlinkSync(outside, image.path, 'file')
  expect(resolveAssetPaths(host, { paths: [image.path] })).toEqual({ results: [null] })
})

it('resolves a symlink outside the blob directory when its realpath is a registered blob', async () => {
  const image = await register()
  const link = join(dir, 'linked-image.png')
  symlinkSync(image.path, link, 'file')
  expect(resolveAssetPaths(host, { paths: [link] })).toEqual({ results: [{ assetId: image.assetId, assetVersionId: image.assetVersionId, kind: 'image', displayName: 'Project image' }] })
})

it('resolves symlink parent traversal according to the file the operating system opens', async () => {
  const image = await register()
  const hash = host.assets.getVersion(host.db, image.assetVersionId)!.blobHash
  const outside = join(dir, 'outside')
  mkdirSync(join(outside, 'deep'), { recursive: true })
  mkdirSync(join(outside, hash.slice(0, 2)))
  copyFileSync(image.path, join(outside, hash.slice(0, 2), hash))
  const link = join(host.assets.blobsDir, 'link')
  symlinkSync(join(outside, 'deep'), link, 'junction')
  const traversal = `${link}${sep}..${sep}${hash.slice(0, 2)}${sep}${hash}`
  // Windows normalizes .. before following links, so this path opens the registered blob.
  const expected = process.platform === 'win32'
    ? { assetId: image.assetId, assetVersionId: image.assetVersionId, kind: 'image', displayName: 'Project image' }
    : null
  expect(resolveAssetPaths(host, { paths: [traversal] })).toEqual({ results: [expected] })
})

it('returns null for non-visual assets and for a project with no blob directory yet', async () => {
  expect(resolveAssetPaths(host, { paths: [join(dir, 'missing')] })).toEqual({ results: [null] })
  const audio = await register('audio', undefined, 'audio')
  expect(resolveAssetPaths(host, { paths: [audio.path] })).toEqual({ results: [null] })
})
