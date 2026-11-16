import { describe, expect, it } from 'vitest'
import { CanvasOp, NodeView, SlotContent } from './canvas'
import { BUILTIN_FONT_FAMILIES, BUILTIN_FONTS, CropRect, ExportOf, FULL_CROP, OverlayPlacement, TEXT_PRESETS, TIMELINE_LIMITS, TimelineDoc, TransformEase, clipDurationMs, clipTransformAt, effectiveFades, evaluateAnimated, fontKey, imageMaxMs, isAnimated, isAudioTrack, isMainVideoTrack, isOverlayTrack, overlayOpacityAt, overlayRect, overlayTracks, sourceTimeAt, timelineDurationMs, visibleTextTracks, type Animated } from './timeline'

const clip = (id: string, startMs: number, inMs: number, outMs: number, extra: object = {}) =>
  ({ id, source: { nodeId: `n-${id}`, assetVersionId: `av-${id}` }, startMs, inMs, outMs, volume: 1, fadeInMs: 0, fadeOutMs: 0, ...extra })
const track = (id: string, kind: 'video' | 'overlay' | 'audio', clips: object[], extra: object = {}) => ({ id, kind, muted: false, volume: 1, clips, ...extra })
const ok = (doc: unknown) => TimelineDoc.safeParse(doc).success

describe('0024 timeline document', () => {
  const valid = {
    version: 1,
    tracks: [
      track('v', 'video', [clip('a', 0, 0, 3000), clip('b', 3000, 500, 2500)]),
      track('m', 'audio', [clip('c', 0, 0, 4000), clip('d', 4500, 0, 1000)]),
    ],
  }

  it('accepts a video track with butted clips and a gapped audio track', () => {
    expect(ok(valid)).toBe(true)
    expect(timelineDurationMs(TimelineDoc.parse(valid))).toBe(5500)
    expect(ok({ version: 1, tracks: [] })).toBe(true)
  })

  it('enforces track limits and order', () => {
    expect(ok({ version: 1, tracks: [track('v1', 'video', []), track('v2', 'video', [])] })).toBe(false)
    const audio = Array.from({ length: TIMELINE_LIMITS.audioTracks + 1 }, (_, i) => track(`a${i}`, 'audio', []))
    expect(ok({ version: 1, tracks: audio })).toBe(false)
    expect(ok({ version: 1, tracks: [track('a', 'audio', []), track('v', 'video', [])] })).toBe(false)
  })

  it('rejects gaps and overlaps on the video track', () => {
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 100, 0, 1000)])] })).toBe(false)
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 1000), clip('b', 1200, 0, 1000)])] })).toBe(false)
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 1000), clip('b', 800, 0, 1000)])] })).toBe(false)
  })

  it('rejects overlapping or unsorted audio clips within a track', () => {
    expect(ok({ version: 1, tracks: [track('m', 'audio', [clip('a', 0, 0, 1000), clip('b', 999, 0, 1000)])] })).toBe(false)
    expect(ok({ version: 1, tracks: [track('m', 'audio', [clip('a', 2000, 0, 1000), clip('b', 0, 0, 1000)])] })).toBe(false)
  })

  it('validates clip ranges, fades and volume', () => {
    const one = (c: object) => ok({ version: 1, tracks: [track('m', 'audio', [c])] })
    expect(one(clip('a', 0, 1000, 1000))).toBe(false)
    expect(one(clip('a', 0, 0, 1000, { fadeInMs: 600, fadeOutMs: 500 }))).toBe(false)
    expect(one(clip('a', 0, 0, 1000, { fadeInMs: 500, fadeOutMs: 500 }))).toBe(true)
    expect(one(clip('a', 0, 0, 1000, { volume: 2.5 }))).toBe(false)
    expect(one(clip('a', 0, 0.5, 1000))).toBe(false)
  })

  it('rejects duplicate ids, odd output sizes and over-long timelines', () => {
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 1000), clip('a', 1000, 0, 1000)])] })).toBe(false)
    expect(ok({ ...valid, output: { width: 1920, height: 1080, fps: 30 } })).toBe(true)
    expect(ok({ ...valid, output: { width: 1921, height: 1080, fps: 30 } })).toBe(false)
    expect(ok({ version: 1, tracks: [track('m', 'audio', [clip('a', TIMELINE_LIMITS.maxDurationMs, 0, 1)])] })).toBe(false)
  })

  it('is wired into slots, canvas ops and node views', () => {
    expect(SlotContent.safeParse({ type: 'timeline', doc: valid }).success).toBe(true)
    expect(SlotContent.safeParse({ type: 'timeline', doc: { version: 1, tracks: [track('v', 'video', [clip('a', 10, 0, 1000)])] } }).success).toBe(false)
    expect(CanvasOp.safeParse({ op: 'timeline.set', slotId: 's', expectedRevision: 1, doc: valid }).success).toBe(true)
    expect(CanvasOp.safeParse({ op: 'timeline.set', slotId: 's', doc: valid }).success).toBe(false)
    expect(CanvasOp.safeParse({ op: 'node.create', tempId: 't', kind: 'timeline', content: { timelineFrom: ['a', 'b'] } }).success).toBe(true)
    expect(CanvasOp.safeParse({ op: 'node.create', tempId: 't', kind: 'timeline', content: { timelineFrom: [] } }).success).toBe(false)
    expect(ExportOf.safeParse({ timelineNodeId: 'n', timelineRevision: 3 }).success).toBe(true)
    expect(NodeView.shape.exportOf.safeParse(null).success).toBe(true)
  })
})

describe('0024d speed, transitions and text', () => {
  const text = (id: string, startMs: number, durationMs: number, extra: object = {}) =>
    ({ id, startMs, durationMs, text: '第一镜：清晨', style: { preset: 'subtitle' }, fadeInMs: 0, fadeOutMs: 0, ...extra })
  const textTrack = (id: string, clips: object[], hidden = false) => ({ id, hidden, clips })

  it('speed shortens or stretches the clip and maps timeline time back to the source', () => {
    const fast = clip('a', 0, 1000, 5000, { speed: 2 })
    expect(clipDurationMs(fast)).toBe(2000)
    expect(sourceTimeAt(fast, 500)).toBe(2000)
    expect(clipDurationMs(clip('b', 0, 0, 1000, { speed: 0.75 }))).toBe(1333)
    expect(ok({ version: 1, tracks: [track('v', 'video', [fast, clip('c', 2000, 0, 1000)])] })).toBe(true)
    // The next video clip starts at the sped-up end, not after the source length
    expect(ok({ version: 1, tracks: [track('v', 'video', [fast, clip('c', 4000, 0, 1000)])] })).toBe(false)
    for (const speed of [0.2, 4.5, 1.234]) expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 1000, { speed })])] })).toBe(false)
    // Fades are timeline milliseconds and must fit the sped-up length
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 4000, { speed: 2, fadeInMs: 1000, fadeOutMs: 1500 })])] })).toBe(false)
  })

  it('a transition overlaps the previous clip, shortens the timeline and must fit both clips', () => {
    const crossfade = { kind: 'crossfade', durationMs: 500 }
    const doc = { version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000), clip('b', 1500, 0, 2000, { transitionIn: crossfade })])] }
    expect(ok(doc)).toBe(true)
    expect(timelineDurationMs(TimelineDoc.parse(doc))).toBe(3500)
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000), clip('b', 2000, 0, 2000, { transitionIn: crossfade })])] })).toBe(false)
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000, { transitionIn: crossfade })])] })).toBe(false)
    // Longer than the previous clip
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 400), clip('b', 0, 0, 2000, { transitionIn: { kind: 'crossfade', durationMs: 400 } }), clip('c', 1600, 0, 2000, { transitionIn: crossfade })])] })).toBe(false)
    // In and out transitions of a middle clip together must fit inside it
    const long = { kind: 'dip', durationMs: 600 }
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000), clip('b', 1400, 0, 1000, { transitionIn: long }), clip('c', 1800, 0, 2000, { transitionIn: long })])] })).toBe(false)
    for (const durationMs of [100, 2500]) expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 3000), clip('b', 3000 - durationMs, 0, 3000, { transitionIn: { kind: 'crossfade', durationMs } })])] })).toBe(false)
    expect(ok({ version: 1, tracks: [track('m', 'audio', [clip('a', 0, 0, 2000), clip('b', 2000, 0, 2000, { transitionIn: crossfade })])] })).toBe(false)
  })

  it('sound fades across a transition last at least as long as the transition', () => {
    const doc = TimelineDoc.parse({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000, { fadeOutMs: 200 }), clip('b', 1500, 0, 2000, { transitionIn: { kind: 'crossfade', durationMs: 500 }, fadeInMs: 800 })])] })
    expect(effectiveFades(doc.tracks[0]!, 0)).toEqual({ fadeInMs: 0, fadeOutMs: 500 })
    expect(effectiveFades(doc.tracks[0]!, 1)).toEqual({ fadeInMs: 800, fadeOutMs: 0 })
  })

  it('text tracks hold sorted, non-overlapping clips in absolute time and count toward the length', () => {
    const doc = { version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000)])], textTracks: [textTrack('t', [text('x', 0, 1000), text('y', 1500, 3000)])] }
    expect(ok(doc)).toBe(true)
    expect(timelineDurationMs(TimelineDoc.parse(doc))).toBe(4500)
    expect(ok({ version: 1, tracks: [], textTracks: [textTrack('t', [text('x', 0, 1000), text('y', 900, 1000)])] })).toBe(false)
    expect(ok({ version: 1, tracks: [], textTracks: [textTrack('t', []), textTrack('u', []), textTrack('w', [])] })).toBe(false)
    // Ids are unique across media and text tracks
    expect(ok({ version: 1, tracks: [track('v', 'video', [clip('a', 0, 0, 2000)])], textTracks: [textTrack('t', [text('a', 0, 1000)])] })).toBe(false)
    expect(ok({ version: 1, tracks: [], textTracks: [textTrack('t', [text('x', 0, 100)])] })).toBe(false)
    expect(ok({ version: 1, tracks: [], textTracks: [textTrack('t', [text('x', 0, 1000, { fadeInMs: 600, fadeOutMs: 600 })])] })).toBe(false)
  })

  it('text is at most three lines with no control characters other than line breaks', () => {
    const one = (value: string) => ok({ version: 1, tracks: [], textTracks: [textTrack('t', [text('x', 0, 1000, { text: value })])] })
    expect(one('第一行\n第二行\n第三行')).toBe(true)
    expect(one('一\n二\n三\n四')).toBe(false)
    expect(one('   ')).toBe(false)
    expect(one('制表\t符')).toBe(false)
    expect(one('长'.repeat(TIMELINE_LIMITS.textMaxChars + 1))).toBe(false)
  })

  it('styles take a preset and optional overrides; fonts are built-in ids or font asset versions', () => {
    const styled = (style: object) => ok({ version: 1, tracks: [], textTracks: [textTrack('t', [text('x', 0, 1000, { style })])] })
    expect(styled({ preset: 'variety', font: { builtin: 'lxgw-wenkai' }, sizePct: 6, color: '#FFE14D', position: 'top' })).toBe(true)
    expect(styled({ preset: 'title', font: { assetVersionId: 'av_font' } })).toBe(true)
    expect(styled({ preset: 'title', font: { builtin: 'comic-sans' } })).toBe(false)
    expect(styled({ preset: 'subtitle', color: 'white' })).toBe(false)
    expect(styled({ preset: 'subtitle', sizePct: 30 })).toBe(false)
    expect(styled({ preset: 'karaoke' })).toBe(false)
    expect(fontKey({ builtin: 'noto-sans-sc' })).toBe('builtin:noto-sans-sc')
    expect(fontKey({ assetVersionId: 'av_1' })).toBe('asset:av_1')
    for (const preset of Object.values(TEXT_PRESETS)) expect(BUILTIN_FONTS).toContain(preset.font)
    expect(Object.keys(BUILTIN_FONT_FAMILIES).sort()).toEqual([...BUILTIN_FONTS].sort())
  })

  it('hidden and empty text tracks are not drawn', () => {
    const doc = TimelineDoc.parse({ version: 1, tracks: [], textTracks: [textTrack('t', [text('x', 0, 1000)], true), textTrack('u', [])] })
    expect(visibleTextTracks(doc)).toEqual([])
  })
})

describe('0024e overlay tracks', () => {
  const place = { x: 0.9, y: 0.1, width: 0.12, opacity: 1 }
  const logo = (id: string, startMs: number, outMs: number, extra: object = {}) => clip(id, startMs, 0, outMs, { overlay: place, ...extra })
  const doc = (...tracks: object[]) => ({ version: 1, tracks })

  it('accepts gapped overlay clips between the main video and audio tracks and counts them in the length', () => {
    const value = doc(track('v', 'video', [clip('a', 0, 0, 3000)]), track('o', 'overlay', [logo('l1', 500, 1000), logo('l2', 2000, 4000)]), track('m', 'audio', []))
    expect(ok(value)).toBe(true)
    expect(timelineDurationMs(TimelineDoc.parse(value))).toBe(6000)
    expect(ok(doc(track('o', 'overlay', [logo('l', 0, 1000)])))).toBe(true)
  })

  it('enforces the overlay track limit and the video, overlay, audio order', () => {
    const overlays = Array.from({ length: TIMELINE_LIMITS.overlayTracks + 1 }, (_, i) => track(`o${i}`, 'overlay', []))
    expect(ok(doc(...overlays))).toBe(false)
    expect(ok(doc(track('o', 'overlay', []), track('v', 'video', [])))).toBe(false)
    expect(ok(doc(track('m', 'audio', []), track('o', 'overlay', [])))).toBe(false)
    const many = Array.from({ length: TIMELINE_LIMITS.overlayClipsPerTrack + 1 }, (_, i) => logo(`l${i}`, i * 1000, 1000))
    expect(ok(doc(track('o', 'overlay', many)))).toBe(false)
    expect(ok(doc(track('o', 'overlay', many.slice(1))))).toBe(true)
  })

  it('requires a placement on overlay clips only, and rejects overlaps and transitions there', () => {
    expect(ok(doc(track('o', 'overlay', [clip('l', 0, 0, 1000)])))).toBe(false)
    expect(ok(doc(track('v', 'video', [logo('a', 0, 1000)])))).toBe(false)
    expect(ok(doc(track('m', 'audio', [logo('a', 0, 1000)])))).toBe(false)
    expect(ok(doc(track('o', 'overlay', [logo('l1', 0, 1000), logo('l2', 999, 1000)])))).toBe(false)
    expect(ok(doc(track('o', 'overlay', [logo('l1', 0, 1000), logo('l2', 1000, 1000, { transitionIn: { kind: 'crossfade', durationMs: 500 } })])))).toBe(false)
  })

  it('bounds placements: centre 0–1 with three decimals, width 0.02–1, opacity 0–1 with two decimals', () => {
    const at = (overlay: object) => ok(doc(track('o', 'overlay', [clip('l', 0, 0, 1000, { overlay })])))
    expect(at({ x: 0, y: 1, width: 1, opacity: 0 })).toBe(true)
    expect(at({ ...place, x: 1.1 })).toBe(false)
    expect(at({ ...place, x: 0.1234 })).toBe(false)
    expect(at({ ...place, width: 0.01 })).toBe(false)
    expect(at({ ...place, opacity: 0.555 })).toBe(false)
    expect(at({ ...place, rotation: 10 })).toBe(false)
  })

  it('only overlay tracks can be hidden; hidden and empty overlay tracks are not drawn', () => {
    expect(ok(doc(track('m', 'audio', [], { hidden: true })))).toBe(false)
    const value = TimelineDoc.parse(doc(track('v', 'video', []), track('o1', 'overlay', [logo('a', 0, 1000)]), track('o2', 'overlay', [logo('b', 0, 1000)], { hidden: true })))
    expect(overlayTracks(value).map(t => t.id)).toEqual(['o1'])
    expect(overlayTracks(TimelineDoc.parse(doc(track('o', 'overlay', []))))).toEqual([])
  })

  it('classifies tracks and allows long images on overlay tracks only', () => {
    expect([isMainVideoTrack, isOverlayTrack, isAudioTrack].map(is => is({ kind: 'overlay' }))).toEqual([false, true, false])
    expect(imageMaxMs({ kind: 'overlay' })).toBe(TIMELINE_LIMITS.maxDurationMs)
    expect(imageMaxMs({ kind: 'video' })).toBe(TIMELINE_LIMITS.imageMaxMs)
  })

  it('fades the overlay picture linearly with its opacity and hides it outside the clip', () => {
    const c = TimelineDoc.parse(doc(track('o', 'overlay', [logo('l', 1000, 2000, { overlay: { ...place, opacity: 0.5 }, fadeInMs: 500, fadeOutMs: 1000 })]))).tracks[0]!.clips[0]!
    expect(overlayOpacityAt(c, 999)).toBe(0)
    expect(overlayOpacityAt(c, 1250)).toBeCloseTo(0.25)
    expect(overlayOpacityAt(c, 1600)).toBeCloseTo(0.5)
    expect(overlayOpacityAt(c, 2500)).toBeCloseTo(0.25)
    expect(overlayOpacityAt(c, 3000)).toBe(0)
  })

  it('maps a placement to an even pixel rectangle that keeps the source aspect ratio', () => {
    expect(overlayRect(place, 1, { width: 1920, height: 1080 })).toEqual({ x: 1613, y: -7, width: 230, height: 230 })
    expect(overlayRect({ x: 0.5, y: 0.5, width: 1, opacity: 1 }, 16 / 9, { width: 1280, height: 720 })).toEqual({ x: 0, y: 0, width: 1280, height: 720 })
    const tiny = overlayRect({ x: 0, y: 0, width: 0.02, opacity: 1 }, 10, { width: 64, height: 64 })
    expect(tiny).toMatchObject({ width: 2, height: 2 })
  })
})

describe('0050 clip transforms', () => {
  const key = <T>(t: number, value: T, ease: TransformEase = 'linear') => ({ t, value, ease })
  const full = { x: 0, y: 0, width: 1, height: 1 }
  const inset = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
  const document = (crop: unknown, kind = 'video') => ({ version: 1, tracks: [track('v', kind as 'video' | 'audio', [clip('c', 0, 2000, 8000, { crop })])] })

  it('shares the animation guard and immutable whole-frame default across consumers', () => {
    expect(isAnimated(undefined)).toBe(false)
    expect(isAnimated(0.5)).toBe(false)
    expect(isAnimated(FULL_CROP)).toBe(false)
    expect(isAnimated({ keys: [key(0, 0.2), key(1000, 0.8)] })).toBe(true)
    expect(FULL_CROP).toEqual({ x: 0, y: 0, width: 1, height: 1 })
    expect(Object.isFrozen(FULL_CROP)).toBe(true)
    expect(evaluateAnimated(FULL_CROP, 500)).toBe(FULL_CROP)
    expect(clipTransformAt({}, 500, { width: 1920, height: 1080 }, { width: 320, height: 240 }).crop).toEqual({ x: 0, y: 0, width: 320, height: 240 })
  })

  it('keeps static transforms plain and accepts source keys outside the trimmed range', () => {
    expect(TimelineDoc.parse(document(inset)).tracks[0]!.clips[0]!.crop).toEqual(inset)
    const crop = { keys: [key(0, full), key(10_000, inset)] }
    expect(TimelineDoc.parse(document(crop)).tracks[0]!.clips[0]!.crop).toEqual(crop)
    expect(ok(document({ keys: [key(0, full)] }))).toBe(false)
    expect(ok(document(inset, 'audio'))).toBe(false)
    expect(TransformEase.safeParse('bezier').success).toBe(false)
  })

  it('bounds crop rectangles, precision and aspect variation across every key', () => {
    for (const value of [{ ...inset, x: 0.3 }, { ...inset, y: 0.3 }, { ...inset, width: 0.049 }, { ...inset, x: 0.1234 }, { ...inset, rotation: 0 }]) {
      expect(CropRect.safeParse(value).success).toBe(false)
    }
    expect(CropRect.safeParse({ x: 0.8, y: 0.8, width: 0.2, height: 0.2 }).success).toBe(true)
    expect(ok(document({ keys: [key(0, full), key(1000, { ...inset, height: 0.803 })] }))).toBe(true)
    const bad = TimelineDoc.safeParse(document({ keys: [key(0, full), key(1000, { ...inset, height: 0.81 })] }))
    expect(bad.success).toBe(false)
    if (!bad.success) expect(bad.error.issues).toContainEqual(expect.objectContaining({ message: 'crop keys must keep one aspect ratio' }))
    // The extreme pair must also agree when the first key lies between them.
    expect(ok(document({ keys: [key(0, full), key(1000, { ...inset, height: 0.797 }), key(2000, { ...inset, height: 0.803 })] }))).toBe(false)
  })

  it('requires strictly increasing times and two through 32 keys for every property', () => {
    for (const times of [[1000, 1000], [1000, 0], [-1, 1000], [0.5, 1000]]) {
      expect(ok(document({ keys: times.map(t => key(t, full)) }))).toBe(false)
    }
    for (const property of ['x', 'y', 'width', 'opacity'] as const) {
      const placement = { x: 0.5, y: 0.5, width: 0.25, opacity: 1 }
      const keys = Array.from({ length: TIMELINE_LIMITS.transformKeys }, (_, i) => key(i * 100, 0.5))
      expect(OverlayPlacement.safeParse({ ...placement, [property]: { keys } }).success).toBe(true)
      expect(OverlayPlacement.safeParse({ ...placement, [property]: { keys: [...keys, key(4000, 0.5)] } }).success).toBe(false)
      expect(OverlayPlacement.safeParse({ ...placement, [property]: { keys: keys.slice(0, 1) } }).success).toBe(false)
      expect(OverlayPlacement.safeParse({ ...placement, [property]: { keys: [key(1, 0.5), key(1, 0.6)] } }).success).toBe(false)
    }
    const keys = Array.from({ length: 32 }, (_, i) => key(i, full))
    expect(ok(document({ keys }))).toBe(true)
    expect(ok(document({ keys: [...keys, key(32, full)] }))).toBe(false)
  })

  it.each([['linear', 150], ['easeInOut', 131.25], ['hold', 100]] as const)('samples %s with endpoint holds and the earlier key ease', (ease, expected) => {
    const value = { keys: [key(1000, 100, ease), key(3000, 300, 'hold')] }
    expect(evaluateAnimated(value, 1500)).toBe(expected)
    expect(evaluateAnimated(value, -100)).toBe(100)
    expect(evaluateAnimated(value, 1000)).toBe(100)
    expect(evaluateAnimated(value, 3000)).toBe(300)
    expect(evaluateAnimated(value, 9000)).toBe(300)
    expect(evaluateAnimated(0.25, 9000)).toBe(0.25)
  })

  it('interpolates all rectangle components without changing the document', () => {
    const value: Animated<CropRect> = { keys: [key(0, full, 'easeInOut'), key(1000, inset)] }
    const before = structuredClone(value)
    expect(evaluateAnimated(value, 250)).toEqual({ x: 0.015625, y: 0.015625, width: 0.96875, height: 0.96875 })
    expect(value).toEqual(before)
    expect(evaluateAnimated(inset, 250)).toEqual(inset)
  })

  it('maps the same content keys through trimming, moving and speed changes', () => {
    const animated = { keys: [key(0, 0), key(10_000, 1)] }
    const original = clip('c', 500, 2000, 8000, { speed: 2 })
    expect(evaluateAnimated(animated, sourceTimeAt(original, 1500))).toBe(0.4)
    expect(evaluateAnimated(animated, sourceTimeAt({ ...original, startMs: 1500 }, 2500))).toBe(0.4)
    expect(evaluateAnimated(animated, sourceTimeAt({ ...original, speed: 1 }, 1500))).toBe(0.3)
  })

  it('returns source-pixel crops and a fitted main picture or independently animated overlay', () => {
    const crop = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }
    const output = { width: 1280, height: 720 }
    const size = { width: 320, height: 240 }
    expect(clipTransformAt({ crop }, 500, output, size)).toEqual({ crop: { x: 80, y: 60, width: 160, height: 120 }, rect: { x: 160, y: 0, width: 960, height: 720 }, opacity: 1 })
    const overlay = { x: { keys: [key(0, 0.25), key(1000, 0.75)] }, y: 0.5,
      width: { keys: [key(0, 0.25), key(1000, 0.5)] }, opacity: { keys: [key(0, 0.25), key(1000, 0.75)] } }
    expect(clipTransformAt({ crop, overlay }, 500, output, size)).toEqual({ crop: { x: 80, y: 60, width: 160, height: 120 }, rect: { x: 400, y: 180, width: 480, height: 360 }, opacity: 0.5 })
    const c = { ...clip('c', 500, 1000, 2000), overlay: { ...overlay, opacity: { keys: [key(1000, 0), key(2000, 1)] } } }
    expect(overlayOpacityAt(c, 1000)).toBe(0.5)
  })
})
