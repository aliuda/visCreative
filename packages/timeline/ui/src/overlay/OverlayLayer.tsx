import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { isOverlayTrack, type OverlayPlacement, type TimelineClip, type TimelineOutput, type TimelineTrack } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from '../types'
import { timelineEditorMessages } from '../messages'
import { createOverlayMediaPlayer, type OverlayPreviewState } from './media'
import { useMediaResources } from '../model/resources'
import { mediaSize, paintTransform, writeStyle } from '../player/transform'
import { locateClip } from '../model/edit'
import { canMovePlacement, canResizePlacement, croppedAspectAt, editPlacement, movePlacement, POINTER_DEAD_ZONE_PX, resizePlacement, resolvePlacement, type Corner } from './placement'
import { canAddKey, keyLimitTitle, playheadSourceTime } from '../model/keys'
import { applyClipTransform, type TransformRefusal } from '../model/transform'
import './overlay.css'

type Output = Pick<TimelineOutput, 'width' | 'height'>
type OverlayRefusal = TransformRefusal | 'keyLimit'
type Gesture = { id: string; placement: OverlayPlacement; next: OverlayPlacement; x: number; y: number; corner?: Corner; pointerId: number; sourceMs: number; moved: boolean; limitReported?: boolean }

function OverlayTrack({ track, output, onState, onRefused, ...parts }: EditorPartProps & { track: TimelineTrack; output: Output; onState(id: string, state?: OverlayPreviewState): void; onRefused(id: string, reason?: OverlayRefusal): void }) {
  const m = useMessages(timelineEditorMessages)
  const cache = useMediaResources(parts.host, track.clips.map(clip => clip.source.assetVersionId))
  const elements = useRef<(HTMLDivElement | null)[]>([])
  const assigned = useRef<(TimelineClip | undefined)[]>([])
  const player = useRef<ReturnType<typeof createOverlayMediaPlayer> | null>(null)
  const gesture = useRef<Gesture | null>(null)
  const latest = useRef({ track, output, parts, m })
  latest.current = { track, output, parts, m }
  const sourceAspect = (clip: TimelineClip, element?: HTMLDivElement | null) => {
    const media = element?.querySelector('video, img') as HTMLVideoElement | HTMLImageElement | null
    const size = mediaSize(media, cache.resolvedInfo(clip.source.assetVersionId))
    return size ? size.width / size.height : 1
  }
  const layout = (element: HTMLDivElement, clip: TimelineClip, placement = clip.overlay!, position = latest.current.parts.clock.now()) => {
    const media = element.querySelector('video, img') as HTMLVideoElement | HTMLImageElement | null
    paintTransform(element, media, clip, position, latest.current.output,
      mediaSize(media, cache.resolvedInfo(clip.source.assetVersionId)), placement)
  }
  const paint = () => player.current?.update()
  const resourceVersion = cache.version()
  useEffect(() => {
    const current = createOverlayMediaPlayer(elements.current as HTMLDivElement[], () => ({ ...latest.current.parts, track: latest.current.track }),
      clip => (cache.resolvedInfo(clip.source.assetVersionId)?.kind ?? latest.current.parts.host.nodes.find(node => node.nodeId === clip.source.nodeId)?.kind) === 'video',
      (element, clip, visible) => {
        const { parts, m } = latest.current
        const index = elements.current.indexOf(element)
        assigned.current[index] = clip
        writeStyle(element.style, 'visibility', visible ? 'visible' : 'hidden')
        const button = element.querySelector('button')!
        if (button.tabIndex !== (visible ? 0 : -1)) button.tabIndex = visible ? 0 : -1
        if (!clip) return
        const position = visible ? parts.clock.now() : clip.startMs
        layout(element, clip, gesture.current?.id === clip.id ? gesture.current.next : clip.overlay!, position)
        if (!visible) return
        const label = m.overlayBox(parts.host.nodes.find(node => node.nodeId === clip.source.nodeId)?.title ?? m.image)
        if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label)
        const selected = String(parts.selection.includes(clip.id))
        if (button.getAttribute('aria-selected') !== selected) button.setAttribute('aria-selected', selected)
        const sourceMs = playheadSourceTime(clip, position)
        const disabled = !!parts.draft.conflict
        if (button.disabled !== disabled) button.disabled = disabled
        button.querySelectorAll<HTMLElement>('[data-corner]').forEach(handle => {
          const display = canResizePlacement(clip.overlay!, sourceMs) ? '' : 'none'
          if (handle.style.display !== display) handle.style.display = display
        })
      }, state => onState(track.id, state), (id, size) => cache.decodedSize(id, size))
    player.current = current
    return () => {
      player.current = null
      current.dispose()
      if (gesture.current) latest.current.parts.placementGestures?.set(gesture.current.id)
      onState(track.id)
    }
  }, [parts.clock, cache, onState, track.id])
  useEffect(paint, [track, parts.host, parts.selection, parts.draft.conflict, output, resourceVersion])
  const start = (event: ReactPointerEvent<HTMLButtonElement>, index: number) => {
    if (event.button !== 0 || parts.draft.conflict) return
    const clip = assigned.current[index]
    if (!clip?.overlay) return
    onRefused(clip.id)
    event.preventDefault()
    event.stopPropagation()
    parts.clock.pause()
    parts.select([clip.id])
    event.currentTarget.focus({ preventScroll: true })
    const corner = event.target instanceof HTMLElement ? event.target.dataset.corner as Corner | undefined : undefined
    const sourceMs = playheadSourceTime(clip, parts.clock.now())
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { id: clip.id, placement: clip.overlay, next: clip.overlay, x: event.clientX, y: event.clientY, pointerId: event.pointerId, moved: false, sourceMs, ...(corner ? { corner } : {}) }
    parts.placementGestures?.set(clip.id, clip.overlay)
  }
  const finish = (event: ReactPointerEvent<HTMLButtonElement>, commit: boolean) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (commit && current.moved) {
      const draft = latest.current.parts.draft
      const clip = locateClip(draft.doc, current.id)?.clip
      if (clip?.overlay) {
        const next = resolvePlacement(current.next, current.sourceMs)
        const patch = { x: next.x, y: next.y, ...(current.corner ? { width: next.width } : {}) }
        const result = editPlacement(clip.overlay, patch, current.sourceMs, clip)
        if (result.refused) onRefused(current.id, result.refused)
        else if (result.placement !== clip.overlay) onRefused(current.id, applyClipTransform(draft, { ...clip, overlay: result.placement }))
      } else onRefused(current.id, 'missing')
    } else if (current.moved && latest.current.parts.draft.conflict) onRefused(current.id, 'conflict')
    latest.current.parts.placementGestures?.set(current.id)
    paint()
  }
  return <div className="vis-tl-overlay-track">{[0, 1].map(index => <div key={index} ref={element => { elements.current[index] = element }} className="vis-tl-overlay-slot" style={{ visibility: 'hidden' }}>
    <button type="button" className="vis-tl-overlay-hit" onPointerDown={event => start(event, index)}
      onPointerMove={event => {
        const current = gesture.current
        if (!current || current.pointerId !== event.pointerId) return
        const element = elements.current[index]!
        const frame = element.parentElement!.getBoundingClientRect()
        if (!frame.width || !frame.height) return
        const clip = assigned.current[index]
        if (!clip) return
        current.moved ||= Math.hypot(event.clientX - current.x, event.clientY - current.y) > POINTER_DEAD_ZONE_PX
        if (!current.moved) return
        if (current.corner ? !canResizePlacement(current.placement, current.sourceMs) : !canMovePlacement(current.placement, current.sourceMs)) {
          if (!current.limitReported) { current.limitReported = true; onRefused(current.id, 'keyLimit') }
          return
        }
        const dx = (event.clientX - current.x) / frame.width
        const dy = (event.clientY - current.y) / frame.height
        const tolerance = event.altKey ? undefined : { x: 8 / frame.width, y: 8 / frame.height }
        const sourceMs = current.sourceMs
        const aspect = croppedAspectAt(clip, sourceAspect(clip, element), sourceMs)
        current.next = current.corner
          ? resizePlacement(current.placement, current.corner, dx, dy, aspect, latest.current.output, tolerance, sourceMs)
          : movePlacement(current.placement, dx, dy, aspect, latest.current.output, tolerance, sourceMs, { x: POINTER_DEAD_ZONE_PX / frame.width, y: POINTER_DEAD_ZONE_PX / frame.height })
        layout(element, clip, current.next)
        latest.current.parts.placementGestures?.set(clip.id, current.next)
      }} onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
      onLostPointerCapture={event => { if (gesture.current?.pointerId === event.pointerId) finish(event, false) }}
      onKeyDown={event => {
        const clip = assigned.current[index]
        if (!clip?.overlay || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        onRefused(clip.id)
        const sourceMs = playheadSourceTime(clip, parts.clock.now())
        if (parts.draft.conflict) { onRefused(clip.id, 'conflict'); return }
        const axis = event.key === 'ArrowLeft' || event.key === 'ArrowRight' ? 'x' : 'y'
        if (!canAddKey(clip.overlay[axis], sourceMs)) { onRefused(clip.id, 'keyLimit'); return }
        const step = event.shiftKey ? 0.05 : 0.005
        const aspect = croppedAspectAt(clip, sourceAspect(clip, elements.current[index]), sourceMs)
        const placement = movePlacement(resolvePlacement(clip.overlay, sourceMs), event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0,
          event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, aspect, output, undefined, sourceMs)
        const next = resolvePlacement(placement, sourceMs)
        const result = editPlacement(clip.overlay, { [axis]: next[axis] }, sourceMs, clip)
        if (result.refused) onRefused(clip.id, result.refused)
        else if (result.placement !== clip.overlay) onRefused(clip.id, applyClipTransform(parts.draft, { ...clip, overlay: result.placement }))
      }}>
      {(['nw', 'ne', 'sw', 'se'] as const).map(corner => <span key={corner} data-corner={corner} className={`vis-tl-overlay-handle is-${corner}`} aria-hidden="true" />)}
    </button>
  </div>)}</div>
}

export function OverlayLayer({ onStateChange, ...props }: EditorPartProps & { output: Output; onStateChange(state: OverlayPreviewState): void }) {
  const m = useMessages(timelineEditorMessages)
  const [states, setStates] = useState<Record<string, OverlayPreviewState>>({})
  const f = useFormat()
  const selectionKey = props.selection.join('\0')
  const latestContext = useRef({ doc: props.draft.doc, selectionKey, content: 0, selection: 0 })
  const context = latestContext.current
  // Save acknowledgements retain doc identity; each content/selection transition advances its counter.
  if (context.doc !== props.draft.doc || context.selectionKey !== selectionKey) {
    context.content++
    if (context.selectionKey !== selectionKey) context.selection++
    context.doc = props.draft.doc
    context.selectionKey = selectionKey
  }
  const [notice, setNotice] = useState<{ id: string; reason: OverlayRefusal; context: number; selection: number } | null>(null)
  const restoredMissing = notice?.reason === 'missing' && !!locateClip(props.draft.doc, notice.id)
  // Restoration permanently expires this notice, even if the same clip is removed again.
  useEffect(() => {
    if (restoredMissing) setNotice(previous => previous === notice ? null : previous)
  }, [notice, restoredMissing])
  const visible = notice && (notice.reason === 'missing' ? notice.selection === context.selection && !restoredMissing : notice.context === context.content)
  const currentNotice = visible ? notice.reason === 'keyLimit' ? keyLimitTitle(true, m.keyLimit, f.number) : m[notice.reason] : ''
  const onRefused = useCallback((id: string, reason?: OverlayRefusal) => {
    const current = latestContext.current
    const next = reason ? { id, reason, context: current.content, selection: current.selection } : null
    setNotice(previous => next ?? (previous?.id === id && previous.reason !== 'missing' ? null : previous))
  }, [])
  useEffect(() => {
    // Only editing input clears a missing-clip notice; focus and assistive navigation preserve it.
    const clearMissing = () => setNotice(previous => previous?.reason === 'missing' ? null : previous)
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('input:not([type="range"]):not([type="checkbox"]):not([type="button"]), textarea, select, [contenteditable="true"]')) return
      if (event.altKey) return
      if (event.ctrlKey || event.metaKey) { if (event.key.toLowerCase() === 'z' || (event.ctrlKey && event.key.toLowerCase() === 'y')) clearMissing(); return }
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace'].includes(event.key)) clearMissing()
    }
    window.addEventListener('pointerdown', clearMissing, true)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('pointerdown', clearMissing, true); window.removeEventListener('keydown', key, true) }
  }, [])
  const onState = useCallback((id: string, state?: OverlayPreviewState) => setStates(previous => {
    const next = { ...previous }
    if (state) next[id] = state
    else delete next[id]
    return next
  }), [])
  const loading = Object.values(states).some(state => state.loading)
  const unavailable = Object.values(states).some(state => state.unavailable)
  const limited = Object.values(states).some(state => state.limited)
  useEffect(() => onStateChange({ loading, unavailable, limited }), [onStateChange, loading, unavailable, limited])
  return <><div className="vis-tl-overlays">{props.draft.doc.tracks.filter(isOverlayTrack).map(track => <OverlayTrack key={track.id} {...props} track={track} onState={onState} onRefused={onRefused} />)}</div>
    {currentNotice || limited ? <span className="vis-tl-preview-limited" role="status">{currentNotice || m.previewLimited}</span> : null}
  </>
}
