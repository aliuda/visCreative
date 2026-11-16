import { clipTransformAt, isAnimated, overlayOpacityAt, sourceTimeAt, type TimelineClip, type TimelineOutput } from '@vis/protocol'

export type MediaSize = { width: number; height: number }
export type PreviewClip = Pick<TimelineClip, 'id' | 'crop' | 'overlay' | 'startMs' | 'inMs' | 'outMs' | 'speed' | 'fadeInMs' | 'fadeOutMs'>
type Placement = TimelineClip['overlay']

/** Percentages keep the mapping independent of preview size, including fullscreen. */
export function previewTransform(clip: PreviewClip, position: number, output: Pick<TimelineOutput, 'width' | 'height'>, source: MediaSize) {
  const { crop, rect, opacity } = clipTransformAt(clip, sourceTimeAt(clip, position), output, source)
  return {
    box: { left: `${rect.x / output.width * 100}%`, top: `${rect.y / output.height * 100}%`,
      width: `${rect.width / output.width * 100}%`, height: `${rect.height / output.height * 100}%` },
    transform: `translate(${-crop.x / crop.width * 100}%, ${-crop.y / crop.height * 100}%) scale(${source.width / crop.width}, ${source.height / crop.height})`,
    clipPath: `inset(${crop.y / source.height * 100}% ${(1 - (crop.x + crop.width) / source.width) * 100}% ${(1 - (crop.y + crop.height) / source.height) * 100}% ${crop.x / source.width * 100}%)`,
    opacity: clip.overlay ? overlayOpacityAt(clip, position, opacity) : opacity,
  }
}

/** Decoders expose post-rotation dimensions; stored metadata may describe the encoded orientation. */
export function mediaSize(element: HTMLVideoElement | HTMLImageElement | null, fallback?: Partial<MediaSize>): MediaSize | undefined {
  if (element && 'naturalWidth' in element) {
    // A reused image retains the previous decode while its assigned source loads.
    if (!element.complete || !element.currentSrc || element.currentSrc !== element.src) return undefined
    if (element.naturalWidth && element.naturalHeight) return { width: element.naturalWidth, height: element.naturalHeight }
  } else {
    const video = element as HTMLVideoElement | null
    if (video?.videoWidth && video.videoHeight) return { width: video.videoWidth, height: video.videoHeight }
  }
  return fallback?.width && fallback.height ? { width: fallback.width, height: fallback.height } : undefined
}

export function writeStyle(style: CSSStyleDeclaration, key: 'visibility' | 'opacity' | 'mixBlendMode' | 'objectFit' | 'transform' | 'clipPath', value: string) {
  if (style[key] !== value) style[key] = value
}

type Paint = { clip: PreviewClip; placement: Placement; media: HTMLVideoElement | HTMLImageElement | null; animated: boolean;
  time: number; fade: number; width: number; height: number; outputWidth: number; outputHeight: number; known: boolean }
const paints = new WeakMap<HTMLElement, Paint>()

/** Static pictures do no frame-driven style work; readiness, edits and frame-size changes invalidate the cache. */
export function paintTransform(container: HTMLElement, media: HTMLVideoElement | HTMLImageElement | null,
  clip: PreviewClip, position: number, output: MediaSize, source = mediaSize(media), placement = clip.overlay): boolean {
  const previous = paints.get(container)
  const sameClip = previous?.clip === clip
  const animated = sameClip && previous.placement === placement ? previous.animated
    : isAnimated(clip.crop) || Object.values(placement ?? {}).some(isAnimated)
  const time = animated ? Math.floor(sourceTimeAt(clip, position)) : 0
  const fade = placement ? overlayOpacityAt(clip, position, 1) : 1
  const width = source?.width ?? 0
  const height = source?.height ?? 0
  if (sameClip && previous.placement === placement && previous.media === media && previous.time === time && previous.fade === fade &&
    previous.width === width && previous.height === height && previous.outputWidth === output.width && previous.outputHeight === output.height) return previous.known
  const known = !!source
  paints.set(container, { clip, placement, media, animated, time, fade, width, height, outputWidth: output.width, outputHeight: output.height, known })
  // Overlay controls keep a position even before their media element or dimensions are available.
  if (known || placement) {
    const style = previewTransform(placement === clip.overlay ? clip : { ...clip, overlay: placement }, position, output, source ?? { width: 1, height: 1 })
    for (const key of ['left', 'top', 'width', 'height'] as const) if (container.style[key] !== style.box[key]) container.style[key] = style.box[key]
    if (media && known) {
      writeStyle(media.style, 'objectFit', 'fill')
      writeStyle(media.style, 'transform', style.transform)
      // Overlay selection handles belong to the unclipped container, outside the picture.
      if (placement) writeStyle(media.style, 'clipPath', style.clipPath)
      if (placement) writeStyle(media.style, 'opacity', String(style.opacity))
    }
  }
  if (media && placement) writeStyle(media.style, 'visibility', known ? 'inherit' : 'hidden')
  return known
}
