import type { ResolvedAssetPath, TranscriptItem } from '@vis/protocol'
import { describeError, useFormat, useLocale, useMessages } from '@vis/ui-kit'
import { useEffect, useMemo, useRef, useState } from 'react'
import { localizedToolLabel } from './activity'
import { sessionMessages } from './messages'
import { SessionIcon } from './SessionIcon'
import { viewedImagePaths, type ImageTranscriptGroup, type ToolCall } from './toolGroups'
import { useAutoExpand } from './useAutoExpand'

export type ViewedImageResolution = { status: 'pending' } | { status: 'ready'; asset: ResolvedAssetPath | null } | { status: 'error'; error: unknown }
export type ViewedImageHost = {
  resolveViewedPaths?: ((paths: string[]) => Promise<{ results: (ResolvedAssetPath | null)[] }>) | undefined
  onAssetVersionsChanged?: ((listener: (assetIds: readonly string[]) => void) => () => void) | undefined
  locateViewedAsset?: ((assetVersionId: string) => boolean) | undefined
}
const EMPTY_RESOLUTIONS: ReadonlyMap<string, ViewedImageResolution> = new Map()
type SessionImageCache = {
  entries: Map<string, ViewedImageResolution>
  retried: Set<string>
  assetChanges: Map<string, number>
}

/** Share one path cache and request batch across all image groups, including historical turns. */
export function useViewedImagePaths(sessionId: string | null, items: readonly TranscriptItem[], host: ViewedImageHost): ReadonlyMap<string, ViewedImageResolution> {
  const sessions = useRef(new Map<string, SessionImageCache>())
  const active = useRef<{ sessionId: string | null; cache: SessionImageCache | null }>({ sessionId: null, cache: null })
  if (active.current.sessionId !== sessionId) {
    let cache: SessionImageCache | null = null
    if (sessionId) {
      cache = sessions.current.get(sessionId) ?? { entries: new Map(), retried: new Set(), assetChanges: new Map() }
      cache.retried.clear()
      sessions.current.delete(sessionId)
      sessions.current.set(sessionId, cache)
      if (sessions.current.size > 4) sessions.current.delete(sessions.current.keys().next().value!)
    }
    active.current = { sessionId, cache }
  }
  const cache = active.current.cache
  const paths = useMemo(() => [...new Set(items.flatMap(item => item.kind === 'tool_call' || item.kind === 'tool_result' ? viewedImagePaths({ call: item }) ?? [] : []))], [items])
  const resolver = useRef(host.resolveViewedPaths)
  resolver.current = host.resolveViewedPaths
  const epoch = useRef(0)
  const [revision, refresh] = useState(0)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const notify = () => { if (mounted.current) refresh(value => value + 1) }
  useEffect(() => {
    return host.onAssetVersionsChanged?.(assetIds => {
      const changed = new Set(assetIds)
      const changedAt = ++epoch.current
      let activeInvalidated = false
      for (const cache of sessions.current.values()) {
        for (const id of changed) cache.assetChanges.set(id, changedAt)
        for (const [path, entry] of cache.entries) {
          if (entry.status === 'ready' && entry.asset && changed.has(entry.asset.assetId)) {
            cache.entries.delete(path)
            if (active.current.cache === cache) activeInvalidated = true
          }
        }
      }
      if (activeInvalidated) notify()
    })
  }, [host.onAssetVersionsChanged])
  useEffect(() => {
    if (!cache || !sessionId) return
    const missing = paths.filter(path => {
      const entry = cache.entries.get(path)
      return !entry || entry.status === 'error' && !cache.retried.has(path)
    })
    for (const path of missing) if (cache.entries.get(path)?.status === 'error') cache.retried.add(path)
    for (let start = 0; start < missing.length; start += 64) {
      const batch = missing.slice(start, start + 64)
      const pending: ViewedImageResolution = { status: 'pending' }
      for (const path of batch) cache.entries.set(path, pending)
      const requestedAt = epoch.current
      const request = resolver.current ? resolver.current(batch) : Promise.resolve({ results: batch.map(() => null) })
      void request.then(({ results }) => {
        if (!mounted.current || sessions.current.get(sessionId) !== cache) return
        batch.forEach((path, index) => {
          if (cache.entries.get(path) !== pending) return
          const asset = results[index] ?? null
          // A delayed reply must not restore metadata invalidated while the request was in flight.
          if (asset && (cache.assetChanges.get(asset.assetId) ?? 0) > requestedAt) cache.entries.delete(path)
          else cache.entries.set(path, { status: 'ready', asset })
        })
        if (active.current.cache === cache) notify()
      }, error => {
        if (!mounted.current || sessions.current.get(sessionId) !== cache) return
        for (const path of batch) if (cache.entries.get(path) === pending) cache.entries.set(path, { status: 'error', error })
        if (active.current.cache === cache) notify()
      })
    }
  }, [cache, sessionId, paths, revision])
  return cache?.entries ?? EMPTY_RESOLUTIONS
}

const payload = (item: TranscriptItem | undefined) => (item?.payload ?? {}) as { name?: string; input?: unknown; text?: unknown; isError?: boolean }
const callState = (pair: ToolCall) => payload(pair.result).isError ? 'error' : pair.call && !pair.result ? 'pending' : 'success'
const basename = (path: string) => path.split(/[/\\]/).at(-1) || path

export type ViewedImagesProps = {
  resolutions: ReadonlyMap<string, ViewedImageResolution>
  assetUrl(assetVersionId: string): string
  onOpenAsset(assetVersionId: string): void
}

export function ViewedImages({ group, expanded, onToggle, ...host }: ViewedImagesProps & { group: ImageTranscriptGroup; expanded: boolean; onToggle(): void }) {
  const m = useMessages(sessionMessages)
  const format = useFormat()
  const disclosure = useAutoExpand(expanded, onToggle)
  const [all, setAll] = useState(false)
  const states = new Map<string, ReturnType<typeof callState>>()
  for (const pair of group.calls) for (const path of viewedImagePaths(pair) ?? []) {
    const state = callState(pair)
    const previous = states.get(path)
    if (!previous || state === 'success' || previous === 'error' && state === 'pending') states.set(path, state)
  }
  const count = [...states.values()].filter(state => state === 'success').length
  const limited = !all && group.paths.length > 12
  return <details ref={disclosure.ref} className="vis-item is-tool vis-tool-group vis-viewed-images" aria-label={m.viewedImages(format.number(count))} data-history-items={JSON.stringify(group.calls.flatMap(pair => [pair.call?.itemId, pair.result?.itemId].filter(Boolean)))} onToggle={disclosure.onToggle}>
    <summary className="vis-tool-group-summary" onClick={disclosure.onSummaryClick}>
      <SessionIcon kind="image" /><span>{m.viewedImages(format.number(count))}</span><span className="vis-tool-chevron"><SessionIcon kind="chevron" /></span>
    </summary>
    <div className="vis-viewed-grid">
      {(limited ? group.paths.slice(0, 11) : group.paths).map(path => <ViewedImageTile key={path} path={path} state={states.get(path)!} {...host} />)}
      {limited ? <button type="button" className="vis-viewed-tile vis-viewed-more" aria-label={m.moreViewedImages(format.number(group.paths.length - 11))} onClick={() => { setAll(true); onToggle() }}>{m.viewedImagesOverflow(format.number(group.paths.length - 11))}</button> : null}
    </div>
    <details className="vis-viewed-details" onToggle={onToggle}>
      <summary>{m.viewedImagesDetails}</summary>
      <div className="vis-tool-calls">{group.calls.map(pair => <ImageCallDetails key={pair.call?.itemId ?? pair.result?.itemId} pair={pair} onToggle={onToggle} />)}</div>
    </details>
  </details>
}

function ViewedImageTile({ path, state, resolutions, assetUrl, onOpenAsset }: ViewedImagesProps & { path: string; state: ReturnType<typeof callState> }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const resolution = resolutions.get(path)
  const asset = resolution?.status === 'ready' ? resolution.asset : null
  const src = asset ? assetUrl(asset.assetVersionId) : ''
  const [failedSrc, setFailedSrc] = useState<string>()
  const failed = state === 'error' || resolution?.status === 'error' || !!src && failedSrc === src
  const pending = !failed && (state === 'pending' || !resolution || resolution.status === 'pending')
  const name = asset?.displayName || basename(path)
  if (!pending && !failed && asset) return <button type="button" className="vis-viewed-tile vis-viewed-thumb" aria-label={name} title={name} onClick={() => onOpenAsset(asset.assetVersionId)}>
    <img src={src} alt={name} aria-label={name} loading="lazy" onError={() => setFailedSrc(src)} />
  </button>
  const label = failed ? m.viewedImageFailed : pending ? m.viewingImages : m.notProjectAsset
  if (pending) return <span className="vis-viewed-tile vis-viewed-placeholder is-pending" role="img" aria-label={label} aria-busy="true" title={path} />
  return <span className={`vis-viewed-tile vis-viewed-placeholder is-${failed ? 'error' : 'unresolved'}`} role="img" aria-label={label} title={resolution?.status === 'error' ? `${path}\n${describeError(resolution.error, locale)}` : path}>
    <SessionIcon kind="image" /><span className="vis-viewed-filename">{basename(path)}</span>
    <span className="vis-viewed-placeholder-label">{label}</span>
  </span>
}

function ImageCallDetails({ pair, onToggle }: { pair: ToolCall; onToggle(): void }) {
  const m = useMessages(sessionMessages)
  const { locale } = useLocale()
  const raw = payload(pair.call).name ?? payload(pair.result).name
  const name = raw ? localizedToolLabel(raw, locale) ?? raw : m.toolResult
  const state = callState(pair)
  const input = payload(pair.call).input
  const preview = JSON.stringify(input) ?? ''
  const result = payload(pair.result).text
  return <details className={`vis-tool-call is-${state}`} onToggle={onToggle}>
    <summary><svg className={`vis-tool-status is-${state}`} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      {state === 'error' ? <path d="m4 4 8 8M12 4l-8 8" /> : state === 'pending' ? <circle cx="8" cy="8" r="5.5" strokeDasharray="24 11" /> : <path d="m3 8 3 3 7-7" />}
    </svg><span className="vis-tool-name">{name}</span>{preview ? <span className="vis-tool-preview">{preview.slice(0, 60)}{preview.length > 60 ? '…' : ''}</span> : null}<span className="vis-tool-chevron"><SessionIcon kind="chevron" /></span></summary>
    {pair.call ? <pre>{JSON.stringify(input, null, 2)}</pre> : null}
    {pair.result ? <pre className="vis-tool-result">{typeof result === 'string' ? result : JSON.stringify(result, null, 2)}</pre> : null}
  </details>
}
