import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { FULL_CROP, TIMELINE_LIMITS, evaluateAnimated, isAnimated, type Animated, type CropRect, type TimelineClip, type TransformEase } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import type { EditorPartProps } from './types'
import { timelineEditorMessages } from './messages'
import { subscribePlaybackFrames } from './player'
import { applyClipTransform } from './model/transform'
import { adjacentKey, aspectLocks, canAddKey, cropAspect, editAnimated, editCrop, keyAt, keyLimitTitle, normalizeCropValue, normalizeNumberValue, playheadSourceTime, propertyLabel, timelineTimeAt, refitCrop, removeKey, round, setKey, setKeyEase, transformValue, withTransformValue, type AspectLock, type TransformProperty } from './model/keys'
import { useClipAspectLock, useTransformEditor } from './transform-context'
import { canPresetPlacement, boundedPlacement, croppedAspectAt, presetPlacement, resolvePlacement, type PlacementPreset } from './overlay/placement'

export function Diamond({ state = 'key' }: { state?: 'static' | 'key' | 'animated' }) {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="m8 2 6 6-6 6-6-6Z" fill={state === 'key' ? 'currentColor' : 'none'} />{state === 'animated' && <path d="M8 2v12L2 8Z" fill="currentColor" />}</svg>
}

type FieldProps = EditorPartProps & { clip: TimelineClip }
function KeyControls({ clip, property, onChange, ...parts }: FieldProps & { property: TransformProperty; onChange(clip: TimelineClip): void }) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const value = transformValue(clip, property)
  const label = propertyLabel(property, m)
  const store = useMemo(() => {
    const read = () => {
      const t = playheadSourceTime(clip, parts.clock.now())
      const key = keyAt(value, t)
      return { state: !isAnimated(value) ? 'static' as const : key ? 'key' as const : 'animated' as const,
        previous: adjacentKey(value, t, -1, clip), next: adjacentKey(value, t, 1, clip), ease: key?.ease, limited: !canAddKey(value, t) }
    }
    let state = read()
    return {
      snapshot: () => state,
      subscribe: (listener: () => void) => subscribePlaybackFrames(parts.clock, () => {
        const next = read()
        if (next.state === state.state && next.previous === state.previous && next.next === state.next && next.ease === state.ease && next.limited === state.limited) return
        state = next
        listener()
      }),
    }
  }, [parts.clock, clip, property, value])
  const state = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot)
  const title = state.limited ? m.keyLimit(f.number(TIMELINE_LIMITS.transformKeys)) : m.keyState(label, state.state === 'static' ? m.keyStatic : state.state === 'key' ? m.keyHere : m.keyAnimated)
  const navigate = (t?: number) => { if (t !== undefined) { parts.clock.pause(); parts.clock.seek(timelineTimeAt(clip, t)) } }
  return <div className="vis-tl-key-controls">
    <button type="button" aria-label={m.previousKey(label)} disabled={state.previous === undefined} onClick={() => navigate(state.previous)}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M4 3v10M12 3 6 8l6 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
    <button type="button" aria-label={m.keyState(label, state.state === 'static' ? m.keyStatic : state.state === 'key' ? m.keyHere : m.keyAnimated)} title={title} disabled={state.limited} onClick={() => {
      const t = playheadSourceTime(clip, parts.clock.now())
      const sampled = evaluateAnimated(value, t)
      const added = typeof sampled === 'number' ? round(sampled, property === 'opacity' ? 2 : 3) : sampled
      let next = keyAt(value, t) ? removeKey(value, t, t) : setKey(value, t, added, clip)
      next = property === 'crop' ? normalizeCropValue(next as Animated<CropRect>) : normalizeNumberValue(next as Animated<number>, property === 'opacity' ? 2 : 3)
      onChange(withTransformValue(clip, property, next))
    }}><Diamond state={state.state} /></button>
    <button type="button" aria-label={m.nextKey(label)} disabled={state.next === undefined} onClick={() => navigate(state.next)}><svg aria-hidden="true" viewBox="0 0 16 16"><path d="M12 3v10M4 3l6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg></button>
    {state.ease !== undefined && <select aria-label={m.keyEase(label)} value={state.ease} onChange={event => {
      onChange(withTransformValue(clip, property, setKeyEase(value, playheadSourceTime(clip, parts.clock.now()), event.currentTarget.value as TransformEase)))
    }}>{(['linear', 'easeInOut', 'hold'] as const).map(ease => <option key={ease} value={ease}>{m[ease]}</option>)}</select>}
  </div>
}

/** Focus owns the draft text; playback paints only blurred fields, never the whole Inspector. */
function TransformField({ label, property, cropField, aspect, onChange, onInvalid, ...parts }: FieldProps & {
  label: string; property: TransformProperty; cropField?: keyof CropRect; aspect?: number | undefined; onChange(clip: TimelineClip): void; onInvalid(): void
}) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const input = useRef<HTMLInputElement>(null)
  const value = transformValue(parts.clip, property)
  const sampled = () => {
    const placement = parts.placementGestures?.get(parts.clip.id)
    const active = property !== 'crop' && placement ? placement[property] : value
    const result = evaluateAnimated(active, playheadSourceTime(parts.clip, parts.clock.now()))
    return String(round((typeof result === 'number' ? result : result[cropField!]) * 100, 1))
  }
  const limited = () => !canAddKey(value, playheadSourceTime(parts.clip, parts.clock.now()))
  useEffect(() => {
    const paint = () => {
      if (!input.current) return
      const next = sampled()
      if (document.activeElement !== input.current && input.current.value !== next) input.current.value = next
      const atLimit = limited()
      const disabled = !!parts.draft.conflict || atLimit
      const title = keyLimitTitle(atLimit, m.keyLimit, f.number)
      if (input.current.disabled !== disabled) input.current.disabled = disabled
      if (input.current.title !== title) input.current.title = title
    }
    paint()
    const stopClock = isAnimated(value) ? subscribePlaybackFrames(parts.clock, paint) : undefined
    const stopGesture = parts.placementGestures?.subscribe(paint)
    return () => { stopClock?.(); stopGesture?.() }
  }, [parts.clip, property, cropField, parts.clock, parts.draft.conflict, parts.placementGestures, m])
  return <label className="vis-tl-field"><span>{label} (%)</span><input ref={input} type="number" aria-label={label} min={property === 'width' ? 2 : cropField === 'width' || cropField === 'height' ? 5 : 0} max={100} step={property === 'opacity' ? 1 : 0.1}
    onBlur={event => {
      const raw = event.currentTarget.value
      const n = Number(raw) / 100
      if (!raw.trim() || !Number.isFinite(n)) onInvalid()
      else if (raw !== sampled()) {
        const t = playheadSourceTime(parts.clip, parts.clock.now())
        const current = evaluateAnimated(value, t)
        const next = property === 'crop' ? editCrop(current as CropRect, cropField!, n, aspect)
          : round(Math.min(1, Math.max(property === 'width' ? 0.02 : 0, n)), property === 'opacity' ? 2 : 3)
        onChange(withTransformValue(parts.clip, property, editAnimated(value, t, next, parts.clip)))
      }
      event.currentTarget.value = sampled()
    }} onKeyDown={event => {
      if (event.key === 'Enter') event.currentTarget.blur()
      if (event.key === 'Escape') { event.currentTarget.value = sampled(); event.stopPropagation() }
    }} /></label>
}

function PlacementPresets({ sourceAspect, output, onChange, onLimited, ...parts }: FieldProps & {
  sourceAspect?: number | undefined; output: { width: number; height: number }; onChange(clip: TimelineClip): void; onLimited(): void
}) {
  const m = useMessages(timelineEditorMessages)
  const select = useRef<HTMLSelectElement>(null)
  const { clip, clock } = parts
  const presets = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight', 'centre', 'fullWidth'] as const
  useEffect(() => subscribePlaybackFrames(clock, () => {
    const t = playheadSourceTime(clip, clock.now())
    const aspect = croppedAspectAt(clip, sourceAspect ?? 1, t)
    for (const option of select.current?.options ?? []) {
      if (option.value) option.disabled = !canPresetPlacement(clip.overlay!, option.value as PlacementPreset, aspect, output, t)
    }
  }), [clip, clock, sourceAspect, output])
  return <select ref={select} className="vis-tl-overlay-presets" aria-label={m.overlayPlacement} value="" disabled={!sourceAspect} onChange={event => {
    const t = playheadSourceTime(clip, clock.now())
    const preset = event.currentTarget.value as PlacementPreset
    const aspect = croppedAspectAt(clip, sourceAspect ?? 1, t)
    if (!canPresetPlacement(clip.overlay!, preset, aspect, output, t)) { onLimited(); return }
    onChange({ ...clip, overlay: presetPlacement(clip.overlay!, preset, aspect, output, t, clip) })
  }}><option value="" disabled>{m.overlayPlacement}</option>{presets.map(preset => <option key={preset} value={preset}>{m[preset]}</option>)}</select>
}

export function TransformInspector({ sourceAspect, output, ...parts }: FieldProps & { sourceAspect?: number | undefined; output: { width: number; height: number } }) {
  const m = useMessages(timelineEditorMessages)
  const f = useFormat()
  const editor = useTransformEditor()
  const { clip, draft, clock } = parts
  const [error, setError] = useState('')
  const lock = useClipAspectLock(clip, sourceAspect, output.width / output.height)
  const crop = clip.crop ?? FULL_CROP
  const aspect = sourceAspect ? cropAspect(lock, sourceAspect, output.width / output.height) : undefined
  const invalidAspect = aspect !== undefined && (aspect < 0.05 || aspect > 20)
  const activeAspect = isAnimated(crop) ? crop.keys[0]!.value.width / crop.keys[0]!.value.height : invalidAspect ? undefined : aspect
  const change = (next: TimelineClip) => {
    const refused = applyClipTransform(draft, next)
    setError(refused ? m[refused] : '')
    return refused
  }
  const changeGeometry = (next: TimelineClip) => { if (!change(next) && sourceAspect) editor.setLock(clip.id, lock) }
  const fieldParts = { ...parts, onChange: change, onInvalid: () => setError(m.invalid) }
  return <fieldset className="vis-tl-transform" disabled={!!draft.conflict}><legend>{m.transform}</legend>
    {(error || invalidAspect) && <p role="status" className="vis-tl-notice">{error || m.aspectUnavailable}</p>}
    <div className="vis-tl-transform-heading"><span>{m.crop}</span><KeyControls {...parts} property="crop" onChange={change} /></div>
    {(['x', 'y', 'width', 'height'] as const).map(field => <TransformField {...fieldParts} onChange={changeGeometry} key={field} property="crop" cropField={field} label={m[`crop${field === 'x' ? 'X' : field === 'y' ? 'Y' : field === 'width' ? 'Width' : 'Height'}`]} aspect={activeAspect} />)}
    <label className="vis-tl-field"><span>{m.aspectLock}</span><select aria-label={m.aspectLock} value={lock} disabled={!sourceAspect} onChange={event => {
      const nextLock = event.currentTarget.value as AspectLock
      const nextAspect = cropAspect(nextLock, sourceAspect!, output.width / output.height)
      if (!nextAspect || !change({ ...clip, crop: refitCrop(crop, nextAspect) })) editor.setLock(clip.id, nextLock)
    }}>{aspectLocks.map(option => <option key={option} value={option} disabled={(() => { const ratio = cropAspect(option, sourceAspect ?? 1, output.width / output.height); return ratio !== undefined && (ratio < 0.05 || ratio > 20) })()}>{option === 'free' ? m.free : option === 'output' ? m.outputAspect : option === 'source' ? m.sourceAspect : option}</option>)}</select></label>
    <button type="button" aria-pressed={editor.cropId === clip.id} disabled={!sourceAspect || invalidAspect} onClick={() => {
      clock.pause()
      clock.seek(timelineTimeAt(clip, playheadSourceTime(clip, clock.now())))
      editor.editCrop(editor.cropId === clip.id ? null : clip.id)
    }}>{m.editCrop}</button>
    {clip.overlay && <>
      {(['x', 'y', 'width', 'opacity'] as const).map(property => <div key={property} className="vis-tl-transform-property">
        <TransformField {...fieldParts} property={property} label={propertyLabel(property, m)} />
        <KeyControls {...parts} property={property} onChange={change} />
      </div>)}
      <PlacementPresets {...parts} sourceAspect={sourceAspect} output={output} onChange={change} onLimited={() => setError(keyLimitTitle(true, m.keyLimit, f.number))} />
    </>}
    <button type="button" onClick={() => {
      if (!change({ ...clip, crop: undefined, ...(clip.overlay ? { overlay: boundedPlacement(resolvePlacement(clip.overlay, playheadSourceTime(clip, clock.now()))) } : {}) })) editor.setLock(clip.id, undefined)
      editor.editCrop(null)
    }}>{m.resetTransform}</button>
    <small className="vis-tl-key-hint">{m.keyHint(f.number(TIMELINE_LIMITS.transformKeys))}</small>
  </fieldset>
}
