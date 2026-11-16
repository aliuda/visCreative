import { realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { MethodParams, MethodResult, ResolvedAssetPath } from '@vis/protocol'
import { and, desc, eq, inArray, isNull, spaceSchema as s } from '@vis/storage'
import type { SpaceHost } from './space-host'

export function resolveAssetPaths(host: Pick<SpaceHost, 'assets' | 'db'>, p: MethodParams<'asset.resolvePaths'>): MethodResult<'asset.resolvePaths'> {
  let blobsDir: string
  try { blobsDir = realpathSync.native(host.assets.blobsDir) } catch { return { results: p.paths.map(() => null) } }
  const paths = p.paths.map(path => {
    let canonical: string
    // Native realpath follows symlink/.. segments before checking the blob boundary.
    try { canonical = realpathSync.native(path) } catch { return null }
    const hash = basename(canonical)
    if (!/^[a-f0-9]{64}$/.test(hash) || dirname(canonical) !== join(blobsDir, hash.slice(0, 2))) return null
    return hash
  })
  const hashes = [...new Set(paths.filter((hash): hash is string => hash !== null))]
  const resolved = new Map<string, ResolvedAssetPath>()
  if (hashes.length) {
    const versions = host.db.select({ blobHash: s.assetVersions.blobHash, assetId: s.assets.id, assetVersionId: s.assetVersions.id, kind: s.assets.kind, displayName: s.assets.displayName })
      .from(s.assetVersions).innerJoin(s.assets, eq(s.assets.id, s.assetVersions.assetId))
      .where(and(inArray(s.assetVersions.blobHash, hashes), isNull(s.assets.archivedAt), inArray(s.assets.kind, ['image', 'video'])))
      .orderBy(desc(s.assetVersions.createdAt), desc(s.assetVersions.version), desc(s.assetVersions.id)).all()
    for (const version of versions) {
      if (resolved.has(version.blobHash) || (version.kind !== 'image' && version.kind !== 'video')) continue
      resolved.set(version.blobHash, { assetId: version.assetId, assetVersionId: version.assetVersionId, kind: version.kind, ...(version.displayName !== null ? { displayName: version.displayName } : {}) })
    }
  }
  return { results: paths.map(hash => hash ? resolved.get(hash) ?? null : null) }
}
