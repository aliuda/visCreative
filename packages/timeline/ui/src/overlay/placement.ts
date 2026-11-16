import { FULL_CROP, TIMELINE_LIMITS, evaluateAnimated, isAnimated, overlayRect, type OverlayPlacement, type TimelineClip, type TimelineOutput } from '@vis/protocol'
import { canAddKey, clamp, round, editAnimated, type KeyRange } from '../model/keys'

type Frame = Pick<TimelineOutput, 'width' | 'height'>
export type PlacementPreset = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight' | 'centre' | 'fullWidth'
export type Corner = 'nw' | 'ne' | 'sw' | 'se'
export type PlacementEdit = { placement: OverlayPlacement; refused?: never } | { placement?: never; refused: 'keyLimit' }
export type ResolvedPlacement = Record<keyof OverlayPlacement, number>
// Suppress minor-axis hand drift after the gesture has started; the dominant axis stays responsive.
export const POINTER_DEAD_ZONE_PX = 3

export function resolvePlacement(placement: OverlayPlacement, sourceMs = 0): ResolvedPlacement {
  return { x: evaluateAnimated(placement.x, sourceMs), y: evaluateAnimated(placement.y, sourceMs),
    width: evaluateAnimated(placement.width, sourceMs), opacity: evaluateAnimated(placement.opacity, sourceMs) }
}

export const canMovePlacement = (placement: OverlayPlacement, sourceMs = 0) => canAddKey(placement.x, sourceMs) || canAddKey(placement.y, sourceMs)
export const canResizePlacement = (placement: OverlayPlacement, sourceMs = 0) => canAddKey(placement.x, sourceMs) && canAddKey(placement.y, sourceMs) && canAddKey(placement.width, sourceMs)
export const canPresetPlacement = (placement: OverlayPlacement, preset: PlacementPreset, aspect: number, output: Frame, sourceMs = 0) =>
  Object.keys(placementChanges(placement, presetPatch(placement, preset, aspect, output, sourceMs), sourceMs))
    .every(key => canAddKey(placement[key as keyof OverlayPlacement], sourceMs))

export function croppedAspectAt(clip: Pick<TimelineClip, 'crop'>, sourceAspect: number, sourceMs: number): number {
  const crop = evaluateAnimated(clip.crop ?? FULL_CROP, sourceMs)
  return sourceAspect * crop.width / crop.height
}

export function placementRectAt(clip: Pick<TimelineClip, 'crop'> & { overlay: OverlayPlacement }, sourceAspect: number, output: Frame, sourceMs: number) {
  return overlayRect(clip.overlay, croppedAspectAt(clip, sourceAspect, sourceMs), output, sourceMs)
}

/** Compare at contract precision so a horizontal gesture cannot seed an unchanged y key. */
export function placementChanges(placement: OverlayPlacement, patch: Partial<ResolvedPlacement>, sourceMs: number): Partial<ResolvedPlacement> {
  const changed: Partial<ResolvedPlacement> = {}
  for (const key of ['x', 'y', 'width', 'opacity'] as const) {
    if (patch[key] === undefined) continue
    const value = round(clamp(patch[key], key === 'width' ? TIMELINE_LIMITS.overlayMinWidth : 0, 1), key === 'opacity' ? 2 : 3)
    if (value !== round(evaluateAnimated(placement[key], sourceMs), key === 'opacity' ? 2 : 3)) changed[key] = value
  }
  return changed
}

/** A gesture supplies source time and a range; only changed properties receive a key. */
export function editPlacement(placement: OverlayPlacement, patch: Partial<ResolvedPlacement>, sourceMs?: number, range?: KeyRange): PlacementEdit {
  const changes = placementChanges(placement, patch, sourceMs ?? 0)
  const fields = (Object.keys(changes) as (keyof OverlayPlacement)[])
  if (!fields.length) return { placement }
  if (range && sourceMs !== undefined && fields.some(key => !canAddKey(placement[key], sourceMs))) return { refused: 'keyLimit' }
  const next = { ...placement }
  let edited = false
  for (const key of fields) {
    const value = changes[key]!
    if (range && sourceMs !== undefined) { next[key] = editAnimated(placement[key], sourceMs, value, range); edited = true }
    else if (!isAnimated(placement[key])) { next[key] = value; edited = true }
  }
  return { placement: edited ? next : placement }
}

export function boundedPlacement(placement: OverlayPlacement): OverlayPlacement {
  return {
    x: isAnimated(placement.x) ? placement.x : round(clamp(placement.x, 0, 1)),
    y: isAnimated(placement.y) ? placement.y : round(clamp(placement.y, 0, 1)),
    width: isAnimated(placement.width) ? placement.width : round(clamp(placement.width, TIMELINE_LIMITS.overlayMinWidth, 1)),
    opacity: isAnimated(placement.opacity) ? placement.opacity : Math.round(clamp(placement.opacity, 0, 1) * 100) / 100,
  }
}

export function presetPlacement(placement: OverlayPlacement, preset: PlacementPreset, aspect: number, output: Frame, sourceMs = 0, range?: KeyRange): OverlayPlacement {
  if (!canPresetPlacement(placement, preset, aspect, output, sourceMs)) return placement
  const result = editPlacement(placement, presetPatch(placement, preset, aspect, output, sourceMs), sourceMs, range)
  return result.refused ? placement : result.placement
}

function presetPatch(placement: OverlayPlacement, preset: PlacementPreset, aspect: number, output: Frame, sourceMs: number): Partial<ResolvedPlacement> {
  if (preset === 'fullWidth') return { x: 0.5, y: 0.5, width: 1 }
  if (preset === 'centre') return { x: 0.5, y: 0.5 }
  const rect = overlayRect(placement, aspect, output, sourceMs)
  const halfWidth = rect.width / output.width / 2
  const halfHeight = rect.height / output.height / 2
  return {
    x: preset.endsWith('Right') ? 0.96 - halfWidth : 0.04 + halfWidth,
    y: preset.startsWith('bottom') ? 0.96 - halfHeight : 0.04 + halfHeight,
  }
}

function nearest(value: number, candidates: number[], tolerance: number) {
  const closest = candidates.reduce((best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, Infinity)
  return Math.abs(closest - value) <= tolerance ? closest : value
}

export function movePlacement(placement: OverlayPlacement, dx: number, dy: number, aspect: number, output: Frame, tolerance?: { x: number; y: number }, sourceMs = 0, deadZone?: { x: number; y: number }): OverlayPlacement {
  if (!canMovePlacement(placement, sourceMs)) return placement
  if (deadZone) {
    const x = Math.abs(dx / deadZone.x)
    const y = Math.abs(dy / deadZone.y)
    if (y >= x * 2 && Math.abs(dx) <= deadZone.x) dx = 0
    if (x >= y * 2 && Math.abs(dy) <= deadZone.y) dy = 0
  }
  const resolved = resolvePlacement(placement, sourceMs)
  const rect = overlayRect(placement, aspect, output, sourceMs)
  const halfWidth = rect.width / output.width / 2
  const halfHeight = rect.height / output.height / 2
  const moveX = dx !== 0 && canAddKey(placement.x, sourceMs)
  const moveY = dy !== 0 && canAddKey(placement.y, sourceMs)
  let x = resolved.x + (moveX ? dx : 0)
  let y = resolved.y + (moveY ? dy : 0)
  if (tolerance) {
    if (moveX) x = nearest(x, [0.5, 0.04 + halfWidth, 0.96 - halfWidth], tolerance.x)
    if (moveY) y = nearest(y, [0.5, 0.04 + halfHeight, 0.96 - halfHeight], tolerance.y)
  }
  return { ...placement, ...placementChanges(placement, { x, y }, sourceMs) }
}

/** Keep the opposite corner fixed while the source aspect determines the other dimension. */
export function resizePlacement(placement: OverlayPlacement, corner: Corner, dx: number, dy: number, aspect: number, output: Frame, tolerance?: { x: number; y: number }, sourceMs = 0): OverlayPlacement {
  if (!canResizePlacement(placement, sourceMs)) return placement
  const resolved = resolvePlacement(placement, sourceMs)
  const sx = corner.endsWith('e') ? 1 : -1
  const sy = corner.startsWith('s') ? 1 : -1
  const ratio = output.width / output.height / aspect
  const anchorX = resolved.x - sx * resolved.width / 2
  const anchorY = resolved.y - sy * resolved.width * ratio / 2
  const delta = Math.abs(dx) >= Math.abs(dy / ratio) ? sx * dx : sy * dy / ratio
  let width = clamp(resolved.width + delta, TIMELINE_LIMITS.overlayMinWidth, 1)
  if (tolerance) {
    const candidates = [0.04, 0.5, 0.96]
    width = nearest(width, candidates.map(x => (x - anchorX) * sx), tolerance.x)
    width = nearest(width, candidates.map(y => (y - anchorY) * sy / ratio), tolerance.y / ratio)
  }
  width = clamp(width, TIMELINE_LIMITS.overlayMinWidth, 1)
  return boundedPlacement({ ...placement, width, x: anchorX + sx * width / 2, y: anchorY + sy * width * ratio / 2 })
}
