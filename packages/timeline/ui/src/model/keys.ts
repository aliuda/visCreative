import { FULL_CROP, TIMELINE_LIMITS, evaluateAnimated, isAnimated, sourceTimeAt, type Animated, type CropRect, type TimelineClip, type TransformEase } from '@vis/protocol'

export type TransformProperty = 'crop' | 'x' | 'y' | 'width' | 'opacity'
export type KeyRange = { inMs: number; outMs: number }
export const transformProperties: readonly TransformProperty[] = ['crop', 'x', 'y', 'width', 'opacity']
export const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))
export const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places

export function timelineTimeAt(clip: Pick<TimelineClip, 'startMs' | 'inMs' | 'speed'>, sourceMs: number): number {
  return clip.startMs + (sourceMs - clip.inMs) / (clip.speed ?? 1)
}

export function propertyLabel(property: TransformProperty, labels: { crop: string; overlayX: string; overlayY: string; overlaySize: string; opacity: string }): string {
  const names = { crop: 'crop', x: 'overlayX', y: 'overlayY', width: 'overlaySize', opacity: 'opacity' } as const
  return labels[names[property]]
}

export function initialAspectLock(clip: Pick<TimelineClip, 'crop' | 'overlay'>, sourceAspect?: number, outputAspect?: number): AspectLock {
  if (!clip.crop) return clip.overlay ? 'free' : 'output'
  if (!sourceAspect) return 'free'
  const crops = isAnimated(clip.crop) ? clip.crop.keys.map(key => key.value) : [clip.crop]
  return aspectLocks.find(lock => {
    if (lock === 'free' || (lock === 'output' && !outputAspect)) return false
    const ratio = cropAspect(lock, sourceAspect, outputAspect ?? sourceAspect)!
    return crops.every(crop => Math.max(crop.width / crop.height, ratio) / Math.min(crop.width / crop.height, ratio) <= 1.005 + 1e-9)
  }) ?? 'free'
}

export function playheadSourceTime(clip: TimelineClip, timelineMs: number): number {
  return Math.round(clamp(sourceTimeAt(clip, timelineMs), clip.inMs, clip.outMs))
}

export function keyAt<T>(value: Animated<T>, t: number) {
  return isAnimated(value) ? value.keys.find(key => key.t === Math.round(t)) : undefined
}

export function adjacentKey<T>(value: Animated<T>, t: number, direction: -1 | 1, range?: KeyRange): number | undefined {
  if (!isAnimated(value)) return undefined
  const visible = (time: number) => !range || (time >= range.inMs && time <= range.outMs)
  return direction < 0 ? value.keys.findLast(key => key.t < Math.round(t) && visible(key.t))?.t : value.keys.find(key => key.t > Math.round(t) && visible(key.t))?.t
}

export function canAddKey<T>(value: Animated<T>, t: number): boolean {
  return !isAnimated(value) || !!keyAt(value, t) || value.keys.length < TIMELINE_LIMITS.transformKeys
}

export function keyLimitTitle(limited: boolean, message: (limit: string) => string, number: (n: number) => string): string {
  return limited ? message(number(TIMELINE_LIMITS.transformKeys)) : ''
}

/** The first diamond seeds a second, unchanged anchor so the document never contains one key. */
export function setKey<T extends number | CropRect>(value: Animated<T>, t: number, next: T, range: KeyRange): Animated<T> {
  t = Math.round(clamp(t, range.inMs, range.outMs))
  if (typeof next !== 'number') {
    const crops = isAnimated(value) ? value.keys.map(key => key.value as CropRect) : [value as CropRect]
    const ratios = crops.map(crop => crop.width / crop.height)
    next = fitCrop(next, Math.sqrt(Math.min(...ratios) * Math.max(...ratios))) as T
  }
  if (!isAnimated(value)) {
    const anchor = t === range.inMs ? range.outMs : range.inMs
    return { keys: [{ t: anchor, value, ease: 'linear' as const }, { t, value: next, ease: 'linear' as const }].sort((a, b) => a.t - b.t) }
  }
  const existing = keyAt(value, t)
  if (!existing && !canAddKey(value, t)) return value
  return { keys: existing ? value.keys.map(key => key.t === t ? { ...key, value: next } : key)
    : [...value.keys, { t, value: next, ease: value.keys.findLast(key => key.t < t)?.ease ?? 'linear' }].sort((a, b) => a.t - b.t) }
}

export function editAnimated<T extends number | CropRect>(value: Animated<T>, t: number, next: T, range: KeyRange): Animated<T> {
  return isAnimated(value) ? setKey(value, t, next, range) : next
}

export function removeKey<T extends number | CropRect>(value: Animated<T>, t: number, playhead: number): Animated<T> {
  if (!isAnimated(value) || !keyAt(value, t)) return value
  if (value.keys.length === 2) return evaluateAnimated(value, playhead)
  return { keys: value.keys.filter(key => key.t !== Math.round(t)) }
}

export function setKeyEase<T>(value: Animated<T>, t: number, ease: TransformEase): Animated<T> {
  return isAnimated(value) ? { keys: value.keys.map(key => key.t === Math.round(t) ? { ...key, ease } : key) } : value
}

export function keyMoveBounds<T>(value: Animated<T>, t: number, range: KeyRange) {
  if (!isAnimated(value)) return { min: t, max: t }
  const index = value.keys.findIndex(key => key.t === t)
  if (index < 0) return { min: t, max: t }
  return { min: Math.max(range.inMs, (value.keys[index - 1]?.t ?? -1) + 1),
    max: Math.min(range.outMs, (value.keys[index + 1]?.t ?? Infinity) - 1) }
}

/** Snap on the timeline's frame clock, then map through speed back to integer source milliseconds. */
export function snappedKeyTime(clip: TimelineClip, sourceMs: number, fps: number, bounds: { min: number; max: number }): number {
  const timeline = timelineTimeAt(clip, sourceMs)
  const source = Math.round(sourceTimeAt(clip, Math.round(timeline * fps / 1000) * 1000 / fps))
  if (source >= bounds.min && source <= bounds.max) return source
  const step = 1000 / fps
  const edge = source < bounds.min ? bounds.min : bounds.max
  const edgeTimeline = timelineTimeAt(clip, edge)
  const frame = source < bounds.min ? Math.ceil(edgeTimeline / step) : Math.floor(edgeTimeline / step)
  const inside = Math.round(sourceTimeAt(clip, frame * step))
  return inside >= bounds.min && inside <= bounds.max ? inside : NaN
}

export function transformValue(clip: TimelineClip, property: TransformProperty): Animated<number | CropRect> {
  return property === 'crop' ? clip.crop ?? FULL_CROP : clip.overlay![property]
}

export function withTransformValue(clip: TimelineClip, property: TransformProperty, value: Animated<number | CropRect>): TimelineClip {
  return property === 'crop' ? { ...clip, crop: value as Animated<CropRect> }
    : { ...clip, overlay: { ...clip.overlay!, [property]: value } }
}

export function mergedKeys(clip: TimelineClip): { t: number; properties: TransformProperty[] }[] {
  const keys = new Map<number, TransformProperty[]>()
  for (const property of transformProperties) {
    if (property !== 'crop' && !clip.overlay) continue
    const value = transformValue(clip, property)
    if (isAnimated(value)) for (const key of value.keys) keys.set(key.t, [...keys.get(key.t) ?? [], property])
  }
  return [...keys].sort(([a], [b]) => a - b).map(([t, properties]) => ({ t, properties }))
}

export function visibleTransformKeys(clip: TimelineClip) {
  return mergedKeys(clip).filter(key => key.t >= clip.inMs && key.t <= clip.outMs)
}

export function moveMergedKey(clip: TimelineClip, t: number, requested: number, fps: number): TimelineClip {
  const properties = mergedKeys(clip).find(key => key.t === t)?.properties ?? []
  const bounds = properties.map(property => keyMoveBounds(transformValue(clip, property), t, clip))
  const time = snappedKeyTime(clip, requested, fps, { min: Math.max(clip.inMs, ...bounds.map(b => b.min)), max: Math.min(clip.outMs, ...bounds.map(b => b.max)) })
  if (!Number.isFinite(time)) return clip
  let next = clip
  for (const property of properties) {
    const value = transformValue(next, property)
    if (isAnimated(value)) next = withTransformValue(next, property, { keys: value.keys.map(key => key.t === t ? { ...key, t: time } : key) })
  }
  return next
}

export function removeMergedKey(clip: TimelineClip, t: number, playhead: number): TimelineClip {
  let next = clip
  for (const property of mergedKeys(clip).find(key => key.t === t)?.properties ?? []) {
    const value = removeKey(transformValue(next, property), t, playhead)
    next = withTransformValue(next, property, property === 'crop' ? normalizeCropValue(value as Animated<CropRect>) : normalizeNumberValue(value as Animated<number>, property === 'opacity' ? 2 : 3))
  }
  return next
}

export function normalizeNumberValue(value: Animated<number>, places = 3): Animated<number> {
  return isAnimated(value) ? value : round(value, places)
}

export type AspectLock = 'free' | 'output' | 'source' | '16:9' | '9:16' | '1:1' | '4:3'
export const aspectLocks: readonly AspectLock[] = ['free', 'output', 'source', '16:9', '9:16', '1:1', '4:3']
export function cropAspect(lock: AspectLock, sourceAspect: number, outputAspect: number): number | undefined {
  if (lock === 'free') return undefined
  const pixelAspect = lock === 'source' ? sourceAspect : lock === 'output' ? outputAspect : Number(lock.split(':')[0]) / Number(lock.split(':')[1])
  return pixelAspect / sourceAspect
}

/** Quantization must keep even very small crop keys within the contract's 0.5% aspect tolerance. */
export function fitCrop(crop: CropRect, aspect?: number): CropRect {
  let width = clamp(crop.width, 0.05, 1)
  let height = clamp(crop.height, 0.05, 1)
  if (aspect) {
    width = Math.min(1, Math.max(0.05, 0.05 * aspect, width))
    height = width / aspect
    if (height > 1) { height = 1; width = aspect }
    let best = Infinity
    let dimensions = { width: round(width), height: round(height) }
    for (let h = 50; h <= 1000; h++) {
      const w = Math.round(h * aspect)
      if (w < 50 || w > 1000 || Math.abs(w / h / aspect - 1) > 0.002) continue
      const error = Math.abs(w / 1000 - width) + Math.abs(h / 1000 - height)
      if (error < best) { best = error; dimensions = { width: w / 1000, height: h / 1000 } }
    }
    width = dimensions.width
    height = dimensions.height
  } else { width = round(width); height = round(height) }
  return { x: round(clamp(crop.x + crop.width / 2 - width / 2, 0, 1 - width)),
    y: round(clamp(crop.y + crop.height / 2 - height / 2, 0, 1 - height)), width, height }
}

export function refitCrop(value: Animated<CropRect>, aspect: number): Animated<CropRect> {
  return isAnimated(value) ? { keys: value.keys.map(key => ({ ...key, value: fitCrop(key.value, aspect) })) } : fitCrop(value, aspect)
}

export function normalizeCropValue(value: Animated<CropRect>): Animated<CropRect> {
  return isAnimated(value) ? value : fitCrop(value, value.width / value.height)
}

export function editCrop(crop: CropRect, field: keyof CropRect, value: number, aspect?: number): CropRect {
  if (field === 'x' || field === 'y') {
    return { ...crop, [field]: round(clamp(value, 0, 1 - crop[field === 'x' ? 'width' : 'height'])) }
  }
  const next = { ...crop, [field]: clamp(value, 0.05, 1) }
  if (aspect) {
    if (field === 'height') next.width = next.height * aspect
    else next.height = next.width / aspect
  }
  return fitCrop(next, aspect)
}
