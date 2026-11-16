import { describe, expect, it } from 'vitest'
import { clipTransformAt, overlayRect, sourceTimeAt, type TimelineClip } from '@vis/protocol'
import { playheadSourceTime, keyAt } from '../model/keys'
import { boundedPlacement, canMovePlacement, canPresetPlacement, canResizePlacement, croppedAspectAt, editPlacement, movePlacement, POINTER_DEAD_ZONE_PX, placementRectAt, presetPlacement, resizePlacement, resolvePlacement } from './placement'

const output = { width: 1920, height: 1080 }
const placement = { x: 0.5, y: 0.5, width: 0.25, opacity: 0.7 }

describe('Overlay placement controls', () => {
  it('positions presets inside four percent margins using the source aspect', () => {
    for (const aspect of [0.5, 1, 2]) {
      const topRight = presetPlacement(placement, 'topRight', aspect, output)
      const rect = overlayRect(topRight, aspect, output)
      expect(Math.abs((rect.x + rect.width) / output.width - 0.96)).toBeLessThan(0.001)
      expect(Math.abs(rect.y / output.height - 0.04)).toBeLessThan(0.001)
      const bottomLeft = overlayRect(presetPlacement(placement, 'bottomLeft', aspect, output), aspect, output)
      expect(Math.abs(bottomLeft.x / output.width - 0.04)).toBeLessThan(0.001)
      expect(Math.abs((bottomLeft.y + bottomLeft.height) / output.height - 0.96)).toBeLessThan(0.001)
    }
    expect(presetPlacement(placement, 'centre', 2, output)).toEqual(placement)
    expect(presetPlacement(placement, 'fullWidth', 2, output)).toEqual({ ...placement, width: 1 })
  })
  it('snaps a move to centre and safe margins, and bypasses with no tolerance', () => {
    const tolerance = { x: 0.01, y: 0.01 }
    expect(movePlacement(placement, 0.005, -0.005, 2, output, tolerance)).toEqual(placement)
    expect(movePlacement(placement, 0.005, -0.005, 2, output)).toEqual({ ...placement, x: 0.505, y: 0.495 })
    expect(movePlacement(placement, 0.334, -0.345, 2, output, tolerance)).toEqual({ ...placement, x: 0.835, y: 0.151 })
  })
  it('resizes around the opposite corner with a locked aspect and bounded width', () => {
    const next = resolvePlacement(resizePlacement(placement, 'se', 0.1, 0, 2, output))
    expect(next.width).toBe(0.35)
    expect(next.x - next.width / 2).toBeCloseTo(placement.x - placement.width / 2, 3)
    expect(next.y - next.width * output.width / output.height / 2 / 2).toBeCloseTo(placement.y - placement.width * output.width / output.height / 2 / 2, 3)
    expect(resizePlacement(placement, 'nw', 1, 1, 2, output).width).toBe(0.02)
    expect(resizePlacement(placement, 'se', 2, 2, 2, output).width).toBe(1)
  })
  it('rounds to contract precision and keeps opacity within its range', () => {
    expect(boundedPlacement({ x: -1, y: 2, width: 0.12345, opacity: 0.456 })).toEqual({ x: 0, y: 1, width: 0.123, opacity: 0.46 })
  })
  it('matches export box geometry at the current source time after trims and speed changes', () => {
    const keys = (a: number, b: number) => ({ keys: [{ t: 1000, value: a, ease: 'linear' as const }, { t: 3000, value: b, ease: 'linear' as const }] })
    const clip = { startMs: 500, inMs: 1000, speed: 2, crop: { x: 0.25, y: 0, width: 0.5, height: 1 },
      overlay: { x: keys(0.2, 0.8), y: keys(0.3, 0.7), width: keys(0.2, 0.4), opacity: 1 } }
    for (const timelineMs of [500, 750, 1000, 1499]) {
      const sourceMs = sourceTimeAt(clip, timelineMs)
      expect(placementRectAt(clip, 16 / 9, output, sourceMs)).toEqual(clipTransformAt(clip, sourceMs, output, { width: 1920, height: 1080 }).rect)
    }
    expect(placementRectAt(clip, 16 / 9, output, 2000)).toEqual({ x: 672, y: 216, width: 576, height: 648 })
  })
  it('positions and resizes an 8:9 crop from a 16:9 source using the exported crop aspect', () => {
    const clip = { crop: { x: 0.25, y: 0, width: 0.5, height: 1 } }
    const aspect = croppedAspectAt(clip, 16 / 9, 500)
    expect(aspect).toBe(8 / 9)
    const next = presetPlacement(placement, 'bottomRight', aspect, output, 500)
    const exported = clipTransformAt({ ...clip, overlay: next }, 500, output, { width: 1920, height: 1080 }).rect
    expect(exported.height).toBe(540)
    expect(Math.abs(exported.x + exported.width - output.width * 0.96)).toBeLessThanOrEqual(1)
    expect(Math.abs(exported.y + exported.height - output.height * 0.96)).toBeLessThanOrEqual(1)
    expect(exported.x + exported.width).toBeLessThanOrEqual(Math.ceil(output.width * 0.96))
    expect(exported.y + exported.height).toBeLessThanOrEqual(Math.ceil(output.height * 0.96))
    const resized = resizePlacement(placement, 'se', 0.1, 0, aspect, output, undefined, 500)
    expect(resized).toEqual({ ...placement, x: 0.55, y: 0.6, width: 0.35 })
  })
  it('samples the cropped aspect at the playhead when crop keys differ within the aspect tolerance', () => {
    const clip = { crop: { keys: [{ t: 0, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'linear' as const },
      { t: 1000, value: { x: 0, y: 0, width: 0.8, height: 0.803 }, ease: 'linear' as const }] }, overlay: placement }
    const aspect = croppedAspectAt(clip, 16 / 9, 500)
    const crop = clipTransformAt(clip, 500, output, { width: 1920, height: 1080 }).crop
    expect(aspect).toBeCloseTo(crop.width / crop.height, 12)
    expect(aspect).not.toBe(croppedAspectAt(clip, 16 / 9, 0))
  })
  it('snaps against the keyed width at the playhead and allows position-only presets without flattening it', () => {
    const width = { keys: [{ t: 0, value: 0.1, ease: 'linear' as const }, { t: 1000, value: 0.3, ease: 'linear' as const }] }
    const animated = { ...placement, width }
    const aspect = 8 / 9
    expect(movePlacement(animated, 0.356, 0.257, aspect, output, { x: 0.01, y: 0.01 }, 500)).toEqual({ ...animated, x: 0.86, y: 0.76 })
    expect(canPresetPlacement(animated, 'centre', aspect, output)).toBe(true)
    expect(canPresetPlacement(animated, 'bottomRight', aspect, output)).toBe(true)
    expect(canPresetPlacement(animated, 'fullWidth', aspect, output)).toBe(true)
    expect(presetPlacement({ ...animated, x: 0.4, y: 0.7 }, 'centre', aspect, output, 500)).toEqual(animated)
    expect(presetPlacement(animated, 'fullWidth', aspect, output, 500, { inMs: 0, outMs: 1000 }).width).toEqual({ keys: [width.keys[0], { t: 500, value: 1, ease: 'linear' }, width.keys[1]] })
    const next = presetPlacement(animated, 'bottomRight', aspect, output, 500)
    expect(next.width).toBe(width)
    expect(next).toEqual({ ...animated, x: 0.86, y: 0.76 })
    const x = { keys: width.keys }
    expect(canPresetPlacement({ ...animated, x }, 'centre', aspect, output)).toBe(true)
  })
  it('samples gesture drafts and writes changed properties at source time without flattening other keys', () => {
    const keys = { keys: [{ t: 0, value: 0.2, ease: 'linear' as const }, { t: 1000, value: 0.8, ease: 'linear' as const }] }
    const animated = { x: keys, y: keys, width: keys, opacity: keys }
    const original = structuredClone(animated)
    const moved = resolvePlacement(movePlacement(animated, 0.1, 0.1, 2, output, undefined, 500), 500)
    const committed = editPlacement(animated, { x: moved.x, y: moved.y }, 500, { inMs: 0, outMs: 1000 }).placement!
    expect(resolvePlacement(committed, 500)).toEqual({ x: 0.6, y: 0.6, width: 0.5, opacity: 0.5 })
    expect(committed.x).toEqual({ keys: [keys.keys[0], { t: 500, value: 0.6, ease: 'linear' }, keys.keys[1]] })
    expect(committed.width).toBe(keys)
    expect(committed.opacity).toBe(keys)
    expect(animated).toEqual(original)
    expect(canMovePlacement(animated, 500)).toBe(true)
    expect(canResizePlacement(animated, 500)).toBe(true)
    const full = { keys: Array.from({ length: 32 }, (_, t) => ({ t: t * 100, value: 0.5, ease: 'linear' as const })) }
    expect(canMovePlacement({ ...animated, x: full }, 550)).toBe(true)
    expect(canResizePlacement({ ...animated, width: full }, 550)).toBe(false)
    expect(canMovePlacement({ ...animated, x: full }, 500)).toBe(true)
  })
  it('keeps an unchanged capped axis out of horizontal and vertical gesture writes', () => {
    const full = { keys: Array.from({ length: 32 }, (_, index) => ({ t: index * 100, value: 0.5, ease: 'linear' as const })) }
    const x = { keys: [{ t: 0, value: 0.5, ease: 'linear' as const }, { t: 4000, value: 0.5, ease: 'linear' as const }] }
    const animated = { ...placement, x, y: full }
    const moved = movePlacement(animated, 0.1, 0, 2, output, { x: 0.01, y: 0.01 }, 550)
    expect(moved.y).toBe(full)
    const committed = editPlacement(animated, resolvePlacement(moved, 550), 550, { inMs: 0, outMs: 4000 }).placement!
    expect(keyAt(committed.x, 550)?.value).toBe(0.6)
    expect(committed.y).toBe(full)
    expect(committed.width).toBe(placement.width)
    const vertical = { ...placement, x: full, y: x }
    const verticalDraft = movePlacement(vertical, 0.1, -0.1, 2, output, undefined, 550)
    expect(resolvePlacement(verticalDraft, 550)).toMatchObject({ x: 0.5, y: 0.4 })
    const verticalCommit = editPlacement(vertical, resolvePlacement(verticalDraft, 550), 550, { inMs: 0, outMs: 4000 }).placement!
    expect(verticalCommit.x).toBe(full)
    expect(keyAt(verticalCommit.y, 550)?.value).toBe(0.4)
  })

  it('checks permissions at the same rounded and clamped source time as the write', () => {
    const clip: TimelineClip = { id: 'clip', startMs: 500, inMs: 1000, outMs: 3000, speed: 0.3, source: { nodeId: 'source', assetVersionId: 'asset' }, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
    const full = { keys: Array.from({ length: 32 }, (_, index) => ({ t: index === 31 ? 3000 : 1000 + index * 50, value: 0.5, ease: 'linear' as const })) }
    for (const timeline of [499, 500.2, 10000]) {
      const source = playheadSourceTime(clip, timeline)
      const current = { ...placement, x: full, y: full }
      expect(canMovePlacement(current, source)).toBe(true)
      const next = editPlacement(current, { x: 0.6 }, source, clip).placement!
      expect(keyAt(next.x, source)?.value).toBe(0.6)
      expect(next.y).toBe(full)
    }
  })

  it('leaves pointer drift below three preview pixels out of a gesture commit', () => {
    const keys = { keys: [{ t: 0, value: 0.5, ease: 'linear' as const }, { t: 4000, value: 0.5, ease: 'linear' as const }] }
    const animated = { ...placement, x: keys, y: keys }
    const preview = { width: 800, height: 450 }
    const deadZone = { x: POINTER_DEAD_ZONE_PX / preview.width, y: POINTER_DEAD_ZONE_PX / preview.height }
    const jittered = movePlacement(animated, 80 / preview.width, 1 / preview.height, 2, output, undefined, 550, deadZone)
    const next = editPlacement(animated, resolvePlacement(jittered, 550), 550, { inMs: 0, outMs: 4000 }).placement!
    expect(keyAt(next.x, 550)?.value).toBe(0.6)
    expect(next.y).toBe(keys)
    const intentional = movePlacement(animated, 80 / preview.width, 4 / preview.height, 2, output, undefined, 550, deadZone)
    expect(resolvePlacement(intentional, 550).y).toBe(0.509)
    const returned = movePlacement(animated, 80 / preview.width, 2 / preview.height, 2, output, undefined, 550, deadZone)
    expect(returned.y).toBe(keys)
  })

  it('permits presets when capped properties already match the requested placement', () => {
    const full = { keys: Array.from({ length: 32 }, (_, index) => ({ t: index * 100, value: 0.5, ease: 'linear' as const })) }
    const animated = { ...placement, x: 0.7, y: full }
    const range = { inMs: 0, outMs: 4000 }
    expect(canPresetPlacement(animated, 'centre', 2, output, 550)).toBe(true)
    const centred = presetPlacement(animated, 'centre', 2, output, 550, range)
    expect(centred.x).toBe(0.5)
    expect(centred.y).toBe(full)
    expect(canPresetPlacement(animated, 'fullWidth', 2, output, 550)).toBe(true)
    expect(presetPlacement(animated, 'fullWidth', 2, output, 550, range)).toEqual({ ...animated, x: 0.5, width: 1 })
    expect(canPresetPlacement(animated, 'topRight', 2, output, 550)).toBe(false)
    expect(presetPlacement(animated, 'topRight', 2, output, 550, range)).toBe(animated)
  })

  it('finalizes edited values once at contract precision for static and keyed properties', () => {
    expect(editPlacement(placement, { x: -1, y: 2, width: 0.12345, opacity: 0.456 }).placement!).toEqual({ x: 0, y: 1, width: 0.123, opacity: 0.46 })
    const keys = { keys: [{ t: 0, value: 0.5, ease: 'linear' as const }, { t: 1000, value: 0.5, ease: 'linear' as const }] }
    const next = editPlacement({ ...placement, x: keys }, { x: 0.62345 }, 500, { inMs: 0, outMs: 1000 }).placement!
    expect(keyAt(next.x, 500)?.value).toBe(0.623)
  })

  it('keeps small dominant-axis moves responsive after gesture start and moves equal diagonals on both axes', () => {
    const deadZone = { x: 0.03, y: 0.03 }
    const moved = (x: number, y: number) => resolvePlacement(movePlacement(placement, x / 100, y / 100, 1, output, undefined, 0, deadZone))
    expect(moved(2.5, 2.5)).toEqual({ ...placement, x: 0.525, y: 0.525 })
    expect(moved(2, 1)).toEqual({ ...placement, x: 0.52 })
    expect(moved(1, 2)).toEqual({ ...placement, y: 0.52 })
    expect([2.9, 3, 3.1].map(x => moved(x, 1).x)).toEqual([0.529, 0.53, 0.531])
    const nonsquare = movePlacement(placement, 2.4 / 800, 1 / 200, 1, output, undefined, 0, { x: 3 / 800, y: 3 / 200 })
    expect(nonsquare.y).toBe(placement.y)
    expect(nonsquare.x).toBe(0.503)
  })

  it('preserves unchanged fields and animated keys on a rounded no-op', () => {
    const width = { keys: [{ t: 0, value: 0.1, ease: 'linear' as const }, { t: 1000, value: 0.3, ease: 'linear' as const }] }
    const original = { x: 0.5004, y: 0.1234, width, opacity: 0.7099 }
    const next = editPlacement(original, { x: 0.5004 }, 500, { inMs: 0, outMs: 1000 }).placement!
    expect(next).toBe(original)
    expect(next.width).toBe(width)
  })

  it('tracks near diagonals on both axes through three pixels and suppresses only clear two-to-one drift', () => {
    const deadZone = { x: 0.03, y: 0.03 }
    const moved = (x: number, y: number) => resolvePlacement(movePlacement(placement, x / 100, y / 100, 1, output, undefined, 0, deadZone))
    expect(moved(2.5, 3)).toEqual({ ...placement, x: 0.525, y: 0.53 })
    expect(moved(2.2, 2.3)).toEqual({ ...placement, x: 0.522, y: 0.523 })
    expect(moved(6, 1)).toEqual({ ...placement, x: 0.56 })
    expect([2.9, 3, 3.1].map(y => moved(2.5, y).y)).toEqual([0.529, 0.53, 0.531])
  })

  it('leaves refused and empty edits unchanged and normalizes only accepted changed fields', () => {
    const full = { keys: Array.from({ length: 32 }, (_, i) => ({ t: i * 100, value: 0.5, ease: 'linear' as const })) }
    const original = { x: full, y: 0.1234, width: 0.25, opacity: 0.7099 }
    const range = { inMs: 0, outMs: 4000 }
    expect(editPlacement(original, { x: 0.6 }, 550, range)).toEqual({ refused: 'keyLimit' })
    expect(editPlacement(original, {}, 550, range).placement!).toBe(original)
    expect(editPlacement(original, { x: 0.5004 }, 550, range).placement!).toBe(original)
    const accepted = editPlacement(original, { y: 0.23456 }, 550, range).placement!
    expect(accepted).toEqual({ ...original, y: 0.235 })
    expect(accepted.x).toBe(full)
  })

})
