import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { FULL_CROP, evaluateAnimated, isAnimated, type CropRect, type TimelineClip } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { timelineEditorMessages } from './messages'
import type { EditorPartProps } from './types'
import { useClipAspectLock, useTransformEditor } from './transform-context'
import { useMediaResources } from './model/resources'
import { canAddKey, cropAspect, editAnimated, keyLimitTitle, playheadSourceTime, type AspectLock } from './model/keys'
import { cropHandles, gestureCrop, type CropHandle } from './model/crop'
import { subscribePlaybackFrames } from './player'
import { applyClipTransform } from './model/transform'

type Gesture = { pointerId: number; handle: CropHandle; crop: CropRect; next: CropRect; x: number; y: number; width: number; height: number; t: number; lock: AspectLock | null; aspect: number | undefined }
export function CropEditor({ clip, output, ...parts }: EditorPartProps & { clip: TimelineClip; output: { width: number; height: number } }) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const editor = useTransformEditor()
  const root = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const video = useRef<HTMLVideoElement>(null)
  const limitMessage = useRef<HTMLSpanElement>(null)
  const handles = useRef(new Map<CropHandle, HTMLButtonElement>())
  const handleRefs = useMemo(() => cropHandles.map(handle => (element: HTMLButtonElement | null) => {
    if (element) handles.current.set(handle, element)
    else handles.current.delete(handle)
  }), [])
  const commitMessage = useRef<{ t: number; conflict: boolean; disabled: boolean } | null>(null)
  const limitTitle = useRef('')
  const gesture = useRef<Gesture | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const resources = useMediaResources(parts.host, [clip.source.assetVersionId])
  const info = resources.resolvedInfo(clip.source.assetVersionId)
  const sourceAspect = info?.width && info.height ? info.width / info.height : undefined
  const lock = useClipAspectLock(clip, sourceAspect, output.width / output.height)
  const value = clip.crop ?? FULL_CROP
  const aspect = isAnimated(value) ? value.keys[0]!.value.width / value.keys[0]!.value.height : sourceAspect ? cropAspect(lock, sourceAspect, output.width / output.height) : undefined
  const current = (t = playheadSourceTime(clip, parts.clock.now())) => evaluateAnimated(value, t)
  const blocked = (t = playheadSourceTime(clip, parts.clock.now())) => !!parts.draft.conflict || !canAddKey(value, t)
  const report = (message: string, t?: number) => {
    const time = t ?? playheadSourceTime(clip, parts.clock.now())
    commitMessage.current = message ? { t: time, conflict: !!parts.draft.conflict, disabled: blocked(time) } : null
    if (limitMessage.current) limitMessage.current.textContent = message || limitTitle.current
  }
  const paint = (crop: CropRect) => {
    if (!box.current) return
    box.current.style.left = `${crop.x * 100}%`
    box.current.style.top = `${crop.y * 100}%`
    box.current.style.width = `${crop.width * 100}%`
    box.current.style.height = `${crop.height * 100}%`
  }
  useEffect(() => {
    handles.current.get('move')?.focus({ preventScroll: true })
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]!.contentRect
      setSize({ width: rect.width, height: rect.height })
    })
    observer.observe(root.current!)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let previous: { disabled: boolean; conflict: boolean } | undefined
    return subscribePlaybackFrames(parts.clock, clockEvent => {
      const sourceMs = playheadSourceTime(clip, parts.clock.now())
      if (!gesture.current) paint(current(sourceMs))
      const conflict = !!parts.draft.conflict
      const disabled = conflict || !canAddKey(value, sourceMs)
      const stale = commitMessage.current && (clockEvent || commitMessage.current.conflict !== conflict || (commitMessage.current.disabled !== blocked(commitMessage.current.t) || (previous?.disabled && !disabled)))
      if (stale) commitMessage.current = null
      const changed = disabled !== previous?.disabled || conflict !== previous?.conflict
      if (changed) {
        limitTitle.current = keyLimitTitle(disabled && !conflict, m.keyLimit, f.number)
        for (const button of handles.current.values()) { button.disabled = disabled; button.title = limitTitle.current }
        previous = { disabled, conflict }
      }
      if ((changed || stale) && !commitMessage.current && limitMessage.current) limitMessage.current.textContent = limitTitle.current
      if (video.current && Math.abs(video.current.currentTime * 1000 - sourceMs) > 1) video.current.currentTime = sourceMs / 1000
    })
  }, [parts.clock, clip, aspect, parts.draft.conflict, m, f])
  const commit = (crop: CropRect, t: number, editLock: AspectLock | null = sourceAspect ? lock : null) => {
    if (parts.draft.conflict) { report(m.conflict, t); paint(current()); return }
    if (!canAddKey(value, t)) { report(keyLimitTitle(true, m.keyLimit, f.number), t); paint(current()); return }
    const before = evaluateAnimated(value, t)
    if ((['x', 'y', 'width', 'height'] as const).every(key => before[key] === crop[key])) return
    const refused = applyClipTransform(parts.draft, { ...clip, crop: editAnimated(value, t, crop, clip) })
    if (refused) { report(m[refused], t); paint(current()) }
    else if (editLock !== null) editor.setLock(clip.id, editLock)
  }
  const finish = (event: ReactPointerEvent, save: boolean) => {
    const active = gesture.current
    if (!active || active.pointerId !== event.pointerId) return
    gesture.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (save && (['x', 'y', 'width', 'height'] as const).some(key => active.next[key] !== active.crop[key])) commit(active.next, active.t, active.lock)
    else paint(current())
  }
  const width = Math.min(size.width - 48, (size.height - 64) * (sourceAspect ?? 1))
  const kind = info?.kind ?? parts.host.nodes.find(node => node.nodeId === clip.source.nodeId)?.kind
  return <div ref={root} className="vis-tl-crop-editor" role="group" aria-label={m.cropMode} onPointerDownCapture={() => report('')} onKeyDownCapture={() => report('')} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); editor.editCrop(null) }
  }}>
    <button className="vis-tl-crop-done" onClick={() => editor.editCrop(null)}>{m.doneCrop}</button>
    <div ref={frame} role="group" aria-label={m.cropSource} className="vis-tl-crop-source" style={{ width: Math.max(0, width), aspectRatio: sourceAspect ?? 1 }}>
      {kind === 'video' ? <video ref={video} src={parts.host.assetUrl(clip.source.assetVersionId)} muted playsInline preload="auto" onLoadedMetadata={event => {
        resources.decodedSize(clip.source.assetVersionId, { width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight })
        event.currentTarget.currentTime = playheadSourceTime(clip, parts.clock.now()) / 1000
      }} /> : <img src={parts.host.assetUrl(clip.source.assetVersionId)} alt="" onLoad={event => resources.decodedSize(clip.source.assetVersionId, { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />}
      <div ref={box} className="vis-tl-crop-box">{cropHandles.map((handle, index) => <button key={handle} ref={handleRefs[index]} type="button" className={`vis-tl-crop-handle is-${handle}`} aria-label={m.cropHandle(m[handle])} disabled={!!parts.draft.conflict}
        onPointerDown={event => {
          if (event.button !== 0 || blocked()) return
          event.preventDefault(); event.stopPropagation()
          parts.clock.pause()
          event.currentTarget.focus({ preventScroll: true })
          event.currentTarget.setPointerCapture(event.pointerId)
          const rect = frame.current!.getBoundingClientRect()
          gesture.current = { pointerId: event.pointerId, handle, crop: current(), next: current(), x: event.clientX, y: event.clientY, width: rect.width, height: rect.height, t: playheadSourceTime(clip, parts.clock.now()), lock: sourceAspect ? lock : null, aspect }
        }} onPointerMove={event => {
          const active = gesture.current
          if (!active || active.pointerId !== event.pointerId) return
          active.next = gestureCrop(active.crop, active.handle, (event.clientX - active.x) / active.width, (event.clientY - active.y) / active.height, active.aspect)
          paint(active.next)
        }} onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)} onLostPointerCapture={event => finish(event, false)}
        onKeyDown={event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const t = playheadSourceTime(clip, parts.clock.now())
          if (blocked(t)) { report(parts.draft.conflict ? m.conflict : keyLimitTitle(true, m.keyLimit, f.number), t); return }
          const step = event.shiftKey ? 0.01 : 0.001
          commit(gestureCrop(current(t), handle, event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0, aspect), t)
        }} />)}</div>
    </div>
    <span ref={limitMessage} className="vis-tl-crop-limit" role="status" />
    <span className="vis-tl-crop-help">{m.cropHelp}</span>
  </div>
}
