import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { clipDurationMs, isAnimated, type TimelineClip } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from './types'
import { timelineEditorMessages } from './messages'
import { Diamond } from './TransformInspector'
import { clamp, mergedKeys, moveMergedKey, playheadSourceTime, propertyLabel, round, removeMergedKey, timelineTimeAt, transformValue, visibleTransformKeys } from './model/keys'
import { timecode, timeToPx } from './model/geometry'
import { applyClipTransform, type TransformRefusal } from './model/transform'

export function KeyLane({ clip, zoom, fps, onRefused, ...parts }: Pick<EditorPartProps, 'clock' | 'draft'> & {
  clip: TimelineClip; zoom: number; fps: number; onRefused(reason?: TransformRefusal): void
}) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const [selected, select] = useState<number | null>(null)
  const buttons = useRef(new Map<number, HTMLButtonElement>())
  const restoreFocus = useRef(false)
  useLayoutEffect(() => {
    const button = selected === null ? undefined : buttons.current.get(selected)
    if (restoreFocus.current && button) { button.focus({ preventScroll: true }); restoreFocus.current = false }
  }, [clip, selected])
  const drag = useRef<{ t: number; x: number; next: TimelineClip; moved: boolean; pointerId: number } | null>(null)
  const keys = visibleTransformKeys(clip)
  const width = Math.max(2, timeToPx(clipDurationMs(clip), zoom) - 1)
  const position = (t: number) => clamp(timeToPx(timelineTimeAt(clip, t) - clip.startMs, zoom), Math.min(9, width / 2), Math.max(width - 9, width / 2))
  const seek = (t: number) => { parts.clock.pause(); parts.clock.seek(timelineTimeAt(clip, t)) }
  const apply = (next: TimelineClip) => {
    const refusal = applyClipTransform(parts.draft, next)
    onRefused(refusal)
    return refusal === undefined
  }
  const movedTime = (next: TimelineClip, t: number) => {
    const property = mergedKeys(clip).find(key => key.t === t)!.properties[0]!
    const before = transformValue(clip, property)
    const after = transformValue(next, property)
    return isAnimated(before) && isAnimated(after) ? after.keys[before.keys.findIndex(key => key.t === t)]!.t : t
  }
  const finish = (event: ReactPointerEvent<HTMLButtonElement>, save: boolean) => {
    const active = drag.current
    if (!active || active.pointerId !== event.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    event.currentTarget.style.left = `${position(active.t)}px`
    if (!save) {
      if (active.moved && parts.draft.conflict) onRefused('conflict')
      return
    }
    if (active.moved && !apply(active.next)) return
    const nextTime = movedTime(active.next, active.t)
    restoreFocus.current = true
    select(nextTime)
    seek(nextTime)
  }
  return <div className="vis-tl-key-lane" style={{ left: timeToPx(clip.startMs, zoom), width }} onPointerDown={event => event.stopPropagation()}>{keys.map(key => {
    const properties = key.properties.map(property => propertyLabel(property, m)).join(', ')
    const timelineMs = timelineTimeAt(clip, key.t)
    const frame = timelineMs * fps / 1000
    const time = timecode(timelineMs, fps, f.number)
    const label = m.timelineKey(Math.abs(frame - Math.round(frame)) < 1e-6 ? time : m.keySubframeTime(time, f.number(round(timelineMs))), properties)
    return <button key={key.t} ref={element => { if (element) buttons.current.set(key.t, element); else buttons.current.delete(key.t) }} className={`vis-tl-timeline-key${selected === key.t ? ' is-selected' : ''}`} type="button" aria-label={label} title={label} aria-pressed={selected === key.t} disabled={!!parts.draft.conflict} style={{ left: position(key.t) }}
      onClick={event => { event.stopPropagation(); if (event.detail === 0) { select(key.t); seek(key.t) } }}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault(); event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        event.currentTarget.setPointerCapture(event.pointerId)
        parts.clock.pause()
        drag.current = { t: key.t, x: event.clientX, next: clip, moved: false, pointerId: event.pointerId }
      }} onPointerMove={event => {
        const active = drag.current
        if (!active || active.pointerId !== event.pointerId) return
        const delta = event.clientX - active.x
        active.moved ||= Math.abs(delta) > 3
        if (!active.moved) return
        active.next = moveMergedKey(clip, active.t, active.t + delta * 1000 / zoom * (clip.speed ?? 1), fps)
        event.currentTarget.style.left = `${position(movedTime(active.next, active.t))}px`
      }} onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)} onLostPointerCapture={event => finish(event, false)}
      onKeyDown={event => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault(); event.stopPropagation()
          if (apply(removeMergedKey(clip, key.t, playheadSourceTime(clip, parts.clock.now())))) select(null)
        } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation()
          const next = moveMergedKey(clip, key.t, key.t + (event.key === 'ArrowLeft' ? -1 : 1) * 1000 / fps * (clip.speed ?? 1), fps)
          if (!apply(next)) return
          restoreFocus.current = true
          const nextTime = movedTime(next, key.t)
          select(nextTime); seek(nextTime)
        } else if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); select(key.t); seek(key.t) }
      }}><Diamond /></button>
  })}</div>
}
