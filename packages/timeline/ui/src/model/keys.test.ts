import { describe, expect, it } from 'vitest'
import { CropRect, FULL_CROP, TIMELINE_LIMITS, TimelineClip, TimelineDoc, evaluateAnimated, isAnimated, type Animated } from '@vis/protocol'
import { adjacentKey, canAddKey, cropAspect, editAnimated, editCrop, fitCrop, keyAt, mergedKeys, moveMergedKey, normalizeCropValue, playheadSourceTime, refitCrop, removeKey, removeMergedKey, setKey, setKeyEase, initialAspectLock, timelineTimeAt, propertyLabel, visibleTransformKeys } from './keys'
import { gestureCrop, cropHandles } from './crop'
import { sameDocument, updateClip } from './edit'
import { editPlacement } from '../overlay/placement'

const clip: TimelineClip = { id: 'clip', source: { nodeId: 'source', assetVersionId: 'asset' }, startMs: 500, inMs: 1000, outMs: 5000, speed: 2, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
function moveCurve(value: Animated<number>, t: number, requested: number, current: TimelineClip, fps: number) {
  return moveMergedKey({ ...current, overlay: { x: value, y: 0.5, width: 0.2, opacity: 1 } }, t, requested, fps).overlay!.x
}
const curve: Animated<number> = { keys: [{ t: 0, value: 0.1, ease: 'hold' }, { t: 2000, value: 0.3, ease: 'easeInOut' }, { t: 6000, value: 0.9, ease: 'linear' }] }

describe('source-time transform key edits', () => {
  it('writes static edits plain, seeds a two-key anchor on either boundary, and updates without duplicate keys', () => {
    expect(editAnimated(0.2, 2000, 0.4, clip)).toBe(0.4)
    const first = setKey(0.2, 2000, 0.4, clip)
    expect(first).toEqual({ keys: [{ t: 1000, value: 0.2, ease: 'linear' }, { t: 2000, value: 0.4, ease: 'linear' }] })
    expect(setKey(0.2, 1000, 0.4, clip)).toEqual({ keys: [{ t: 1000, value: 0.4, ease: 'linear' }, { t: 5000, value: 0.2, ease: 'linear' }] })
    expect(setKey(first, 2000, 0.6, clip)).toEqual({ keys: [{ t: 1000, value: 0.2, ease: 'linear' }, { t: 2000, value: 0.6, ease: 'linear' }] })
    expect(keyAt(first, 2000.1)?.value).toBe(0.4)
  })

  it('maps the playhead through trims, speed and clip start, clamping edits to the selected source range', () => {
    expect(playheadSourceTime(clip, 1000)).toBe(2000)
    expect(timelineTimeAt(clip, 2000)).toBe(1000)
    expect(playheadSourceTime(clip, timelineTimeAt(clip, 2600))).toBe(2600)
    expect(playheadSourceTime(clip, 500.2)).toBe(1000)
    expect(playheadSourceTime(clip, 500.3)).toBe(1001)
    expect(playheadSourceTime(clip, -100)).toBe(1000)
    expect(playheadSourceTime(clip, 10000)).toBe(5000)
    expect(setKey(0.2, 9999, 0.4, clip)).toEqual(setKey(0.2, 5000, 0.4, clip))
  })

  it('adds with the preceding segment ease, finds previous/next including keys outside trims, and preserves hidden keys', () => {
    const next = setKey(curve, 3000, 0.5, clip)
    expect(isAnimated(next) && next.keys.map(key => key.t)).toEqual([0, 2000, 3000, 6000])
    expect(keyAt(next, 3000)?.ease).toBe('easeInOut')
    expect(adjacentKey(next, 1000, -1)).toBe(0)
    expect(adjacentKey(next, 3000, 1)).toBe(6000)
    expect(adjacentKey(next, 1000, -1, clip)).toBeUndefined()
    expect(adjacentKey(next, 3000, 1, clip)).toBeUndefined()
    expect(adjacentKey(next, 2000, 1, clip)).toBe(3000)
    expect(adjacentKey(next, 0, -1)).toBeUndefined()
    expect(adjacentKey(next, 6000, 1)).toBeUndefined()
    expect(adjacentKey(0.2, 0, 1)).toBeUndefined()
    expect(keyAt(setKeyEase(next, 3000, 'hold'), 3000)?.ease).toBe('hold')
    expect(setKeyEase(0.2, 3000, 'hold')).toBe(0.2)
    expect(curve).toEqual({ keys: [{ t: 0, value: 0.1, ease: 'hold' }, { t: 2000, value: 0.3, ease: 'easeInOut' }, { t: 6000, value: 0.9, ease: 'linear' }] })
  })

  it('removes a key, returns the pre-removal sampled value when only one key would remain, and does not invent missing keys', () => {
    const pair = removeKey(curve, 0, 2500)
    expect(isAnimated(pair) && pair.keys.map(key => key.t)).toEqual([2000, 6000])
    expect(removeKey(pair, 2000, 3000)).toBe(evaluateAnimated(pair, 3000))
    expect(removeKey(curve, 123, 3000)).toBe(curve)
    expect(removeKey(0.5, 0, 0)).toBe(0.5)
  })

  it('caps additions at 32 while still allowing updates, ease changes and removals', () => {
    const full = { keys: Array.from({ length: TIMELINE_LIMITS.transformKeys }, (_, index) => ({ t: index * 100, value: 0.5, ease: 'linear' as const })) }
    expect(canAddKey(full, 1050)).toBe(false)
    expect(setKey(full, 1050, 0.8, { inMs: 0, outMs: 5000 })).toBe(full)
    expect(canAddKey(full, 1000)).toBe(true)
    expect(keyAt(setKey(full, 1000, 0.8, { inMs: 0, outMs: 5000 }), 1000)?.value).toBe(0.8)
    expect(keyAt(setKeyEase(full, 1000, 'hold'), 1000)?.ease).toBe('hold')
    expect(canAddKey(removeKey(full, 1000, 1000), 1050)).toBe(true)
  })

  it('moves on the frame clock at speed 2, bounded by trims and neighbours, preserving outside keys', () => {
    const moved = moveCurve(curve, 2000, 2670, clip, 10)
    expect(isAnimated(moved) && moved.keys.map(key => key.t)).toEqual([0, 2600, 6000])
    expect(isAnimated(moveCurve(curve, 2000, -1000, clip, 10)) && keyAt(moveCurve(curve, 2000, -1000, clip, 10), 1000)?.value).toBe(0.3)
    expect(keyAt(moveCurve(curve, 2000, 9000, clip, 10), 5000)?.value).toBe(0.3)
    const neighbours = { keys: [{ t: 1800, value: 0.1, ease: 'linear' as const }, { t: 2000, value: 0.3, ease: 'hold' as const }, { t: 2400, value: 0.5, ease: 'linear' as const }] }
    expect(keyAt(moveCurve(neighbours, 2000, 5000, clip, 10), 2200)?.ease).toBe('hold')
    expect(keyAt(moveCurve(neighbours, 2000, 0, clip, 10), 2000)?.value).toBe(0.3)
    const packed = { keys: [{ t: 2000, value: 0.1, ease: 'linear' as const }, { t: 2050, value: 0.3, ease: 'hold' as const }, { t: 2100, value: 0.5, ease: 'linear' as const }] }
    expect(moveCurve(packed, 2050, 2075, clip, 10)).toBe(packed)
  })

  it('moves merged properties together using their tightest neighbour and removes them in one edit', () => {
    const animated = { ...clip, overlay: { x: curve, y: { keys: [{ t: 2000, value: 0.2, ease: 'linear' as const }, { t: 3000, value: 0.4, ease: 'linear' as const }] }, width: 0.3, opacity: 1 } }
    expect(mergedKeys(animated)).toEqual([{ t: 0, properties: ['x'] }, { t: 2000, properties: ['x', 'y'] }, { t: 3000, properties: ['y'] }, { t: 6000, properties: ['x'] }])
    const moved = moveMergedKey(animated, 2000, 5000, 10)
    expect(keyAt(moved.overlay!.x, 2800)?.value).toBe(0.3)
    expect(keyAt(moved.overlay!.y, 2800)?.value).toBe(0.2)
    const removed = removeMergedKey(animated, 2000, 2500)
    expect(isAnimated(removed.overlay!.x) && removed.overlay!.x.keys.map(key => key.t)).toEqual([0, 6000])
    expect(removed.overlay!.y).toBe(0.3)
  })

  it('commits overlay drags into keys while preserving independent curves and static fields', () => {
    const original = { x: curve, y: 0.5, width: curve, opacity: curve }
    const next = editPlacement(original, { x: 0.7, y: 0.6 }, 3000, clip).placement!
    expect(keyAt(next.x, 3000)?.value).toBe(0.7)
    expect(next.y).toBe(0.6)
    expect(next.width).toBe(curve)
    expect(next.opacity).toBe(curve)
    expect(isAnimated(next.x) && next.x.keys.filter(key => key.t !== 3000)).toEqual(isAnimated(curve) && curve.keys)
  })
})

describe('crop aspect and document commits', () => {
  it('refits every key around its centre, bounded inside the source, without changing time or ease', () => {
    const crop = { keys: [{ t: 0, value: FULL_CROP, ease: 'hold' as const }, { t: 1000, value: { x: 0.2, y: 0.3, width: 0.4, height: 0.4 }, ease: 'easeInOut' as const }] }
    const next = refitCrop(crop, 9 / 16)
    expect(isAnimated(next) && next.keys.map(key => [key.t, key.ease])).toEqual([[0, 'hold'], [1000, 'easeInOut']])
    if (!isAnimated(next)) throw new Error('Expected crop keys')
    for (const key of next.keys) {
      expect(CropRect.safeParse(key.value).success).toBe(true)
      expect(key.value.width / key.value.height).toBeCloseTo(9 / 16, 2)
    }
    expect(next.keys[1]!.value.x + next.keys[1]!.value.width / 2).toBeCloseTo(0.4, 3)
    expect(next.keys[1]!.value.y + next.keys[1]!.value.height / 2).toBeCloseTo(0.5, 3)
    expect(TimelineClip.safeParse({ ...clip, crop: next }).success).toBe(true)
    const added = setKey(crop, 500, { x: 0.1, y: 0.1, width: 0.6, height: 0.2 }, { inMs: 0, outMs: 1000 })
    expect(TimelineClip.safeParse({ ...clip, crop: added }).success).toBe(true)
    expect(keyAt(added, 500)!.value.width / keyAt(added, 500)!.value.height).toBe(1)
  })

  it('keeps small crops valid at every supported aspect and rounds collapsed sampled crops', () => {
    for (const lock of ['free', 'source', 'output', '16:9', '9:16', '1:1', '4:3'] as const) {
      const aspect = cropAspect(lock, 16 / 9, 9 / 16)
      const crops = [0.05, 0.1, 0.23, 0.9, 1].map(width => fitCrop({ ...FULL_CROP, width, height: width }, aspect))
      for (const crop of crops) expect(CropRect.safeParse(crop).success).toBe(true)
      if (aspect) expect(TimelineClip.safeParse({ ...clip, crop: { keys: crops.map((value, t) => ({ t, value, ease: 'linear' })) } }).success).toBe(true)
    }
    const sampled = normalizeCropValue({ x: 0.123456, y: 0.222222, width: 0.54321, height: 0.54321 })
    expect(CropRect.safeParse(sampled).success).toBe(true)
    expect(cropAspect('free', 1, 1)).toBeUndefined()
    expect(editCrop({ x: 0.1, y: 0, width: 0.05, height: 1 }, 'x', 0.9, 20)).toEqual({ x: 0.9, y: 0, width: 0.05, height: 1 })
    expect(editCrop({ x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, 'x', 1).x).toBe(0.5)
  })

  it('bounds moves and all eight handle resizes, including keyboard-sized nudges with an aspect lock', () => {
    const crop = { x: 0.2, y: 0.2, width: 0.6, height: 0.6 }
    for (const handle of cropHandles) for (const delta of [-2, -0.001, 0.001, 2]) {
      const result = gestureCrop(crop, handle, delta, delta / 2, 1)
      expect(CropRect.safeParse(result).success, `${handle} ${delta}`).toBe(true)
      expect(result.width / result.height).toBeCloseTo(1, 2)
    }
    expect(gestureCrop(crop, 'move', 2, -2)).toEqual({ ...crop, x: 0.4, y: 0 })
  })

  it('detects crop-only edits, validates them once, and clears crop on reset', () => {
    const doc: TimelineDoc = { version: 1, tracks: [{ id: 'main', kind: 'video', volume: 1, muted: false, clips: [{ ...clip, startMs: 0 }] }] }
    const result = updateClip(doc, clip.id, { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('Expected a crop edit')
    expect(sameDocument(doc, result.doc)).toBe(false)
    const reset = updateClip(result.doc, clip.id, { crop: null })
    expect(reset.ok && sameDocument(doc, reset.doc)).toBe(true)
  })
})


describe('reviewed transform editing semantics', () => {
  it('keeps crop dimensions on x/y edits and movement even when the remembered lock differs', () => {
    const crop = { x: 0.1, y: 0.1, width: 0.7, height: 0.6 }
    expect(editCrop(crop, 'x', 0.2, 0.4)).toEqual({ ...crop, x: 0.2 })
    expect(editCrop(crop, 'y', 0.3, 0.4)).toEqual({ ...crop, y: 0.3 })
    expect(gestureCrop(crop, 'move', 0.1, 0, 0.4)).toEqual({ ...crop, x: 0.2 })
    expect(initialAspectLock({ crop })).toBe('free')
    expect(initialAspectLock({ crop: { keys: [{ t: 0, value: crop, ease: 'linear' }, { t: 1000, value: crop, ease: 'linear' }] } })).toBe('free')
    expect(initialAspectLock({})).toBe('output')
    expect(initialAspectLock({ overlay: { x: 0.5, y: 0.5, width: 0.2, opacity: 1 } })).toBe('free')
  })

  it('derives crop locks from current source-pixel aspects with the contract tolerance', () => {
    const crop = { x: 0.1, y: 0.1, width: 0.6, height: 0.8 }
    expect(initialAspectLock({}, 16 / 9, 9 / 16)).toBe('output')
    expect(initialAspectLock({ crop }, 16 / 9, 9 / 16)).toBe('4:3')
    expect(initialAspectLock({ crop: { ...crop, width: 0.7 } }, 16 / 9, 9 / 16)).toBe('free')
    expect(initialAspectLock({ crop: FULL_CROP }, 16 / 9, 16 / 9)).toBe('output')
    expect(initialAspectLock({ crop: FULL_CROP }, 16 / 9, 9 / 16)).toBe('source')
    expect(initialAspectLock({ crop: { ...crop, width: 0.8, height: 0.6 } }, 4 / 3, 9 / 16)).toBe('16:9')
    expect(initialAspectLock({ crop: { ...crop, width: 0.603 } }, 16 / 9, 9 / 16)).toBe('4:3')
    expect(initialAspectLock({ crop: { ...crop, width: 0.604 } }, 16 / 9, 9 / 16)).toBe('free')
    expect(initialAspectLock({ crop: { keys: [{ t: 0, value: crop, ease: 'linear' }, { t: 1000, value: { ...crop, width: 0.603 }, ease: 'linear' }] } }, 16 / 9, 9 / 16)).toBe('4:3')
  })

  it('leaves a full-frame crop unchanged on a movement nudge and seeds matching values without refitting', () => {
    expect(gestureCrop(FULL_CROP, 'move', 0.001, 0, 0.4)).toEqual(FULL_CROP)
    expect(setKey(FULL_CROP, 1000, FULL_CROP, clip)).toEqual({ keys: [{ t: 1000, value: FULL_CROP, ease: 'linear' }, { t: 5000, value: FULL_CROP, ease: 'linear' }] })
  })

  it('uses one property label map for Inspector and timeline controls', () => {
    const labels = { crop: 'Crop', overlayX: 'X', overlayY: 'Y', overlaySize: 'Size', opacity: 'Alpha' }
    expect(['crop', 'x', 'y', 'width', 'opacity'].map(property => propertyLabel(property as 'crop' | 'x' | 'y' | 'width' | 'opacity', labels))).toEqual(['Crop', 'X', 'Y', 'Size', 'Alpha'])
  })
  it('uses only in-trim keys for visible diamonds and selected clip labels', () => {
    const next = { ...clip, overlay: { x: curve, y: 0.5, width: 0.2, opacity: 1 } }
    expect(visibleTransformKeys(next).map(key => key.t)).toEqual([2000])
    expect(visibleTransformKeys({ ...next, inMs: 2500, outMs: 5000 })).toEqual([])
    expect(mergedKeys(next).map(key => key.t)).toEqual([0, 2000, 6000])
  })

})
