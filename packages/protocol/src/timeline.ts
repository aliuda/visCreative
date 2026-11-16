import { z } from 'zod'
import { Id, Revision } from './common'

// 0024: timeline (edit) documents. Multi-track from the first version; later steps raise the limits
// below instead of changing the shape.

export const TIMELINE_LIMITS = {
  /** The main video track; overlay tracks are counted separately */
  videoTracks: 1,
  audioTracks: 4,
  // 0024e: picture overlays (logos, stickers, later picture-in-picture) drawn above the main track
  overlayTracks: 2,
  // Each overlay clip is one ffmpeg overlay filter, so keep the export graph small
  overlayClipsPerTrack: 50,
  /** Overlay width as a fraction of the output width */
  overlayMinWidth: 0.02,
  transformKeys: 32,
  // 0024d: for example one subtitle track and one title track
  textTracks: 2,
  clipsPerTrack: 200,
  maxDurationMs: 30 * 60_000,
  maxFadeMs: 10_000,
  maxVolume: 2,
  /** Image clips on the video track show for this long */
  imageMinMs: 500,
  imageMaxMs: 30_000,
  minSpeed: 0.25,
  maxSpeed: 4,
  transitionMinMs: 200,
  transitionMaxMs: 2000,
  textMinMs: 200,
  textMaxChars: 200,
  textMaxLines: 3,
  textMinSizePct: 2,
  textMaxSizePct: 20,
} as const

const Ms = z.int().nonnegative()
const Volume = z.number().min(0).max(TIMELINE_LIMITS.maxVolume)
const Fade = z.int().min(0).max(TIMELINE_LIMITS.maxFadeMs)
const Even = (min: number, max: number) => z.int().min(min).max(max).refine(n => n % 2 === 0, { message: 'must be even' })
// Two decimals keep speeds readable in the editor and exact enough for millisecond lengths
const Speed = z.number().min(TIMELINE_LIMITS.minSpeed).max(TIMELINE_LIMITS.maxSpeed)
  .refine(n => Math.abs(n * 100 - Math.round(n * 100)) < 1e-9, { message: 'speed has at most two decimals' })
const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'color must be #RRGGBB')
const Decimals = (min: number, max: number, places: number) => z.number().min(min).max(max)
  .refine(n => Math.abs(n * 10 ** places - Math.round(n * 10 ** places)) < 1e-9, { message: `at most ${places} decimals` })

export const TransformEase = z.enum(['linear', 'easeInOut', 'hold'])
export type TransformEase = z.infer<typeof TransformEase>
type AnimatedKeys<T> = { keys: { t: number; value: T; ease: TransformEase }[] }
export type Animated<T> = T | AnimatedKeys<T>

export function isAnimated<T>(value: Animated<T> | undefined): value is AnimatedKeys<T> {
  return typeof value === 'object' && value !== null && 'keys' in value
}

/** Source-time keys survive trimming and speed changes; a static value stays plain. */
export const Animated = <T extends z.ZodType>(value: T) => z.union([
  value,
  z.strictObject({ keys: z.array(z.strictObject({ t: Ms, value, ease: TransformEase })).min(2).max(TIMELINE_LIMITS.transformKeys) })
    .superRefine(({ keys }, ctx) => {
      keys.forEach((key, index) => {
        if (index && key.t <= keys[index - 1]!.t) ctx.addIssue({ code: 'custom', path: ['keys', index, 't'], message: 'keyframe times must increase strictly' })
      })
    }),
])

export const CropRect = z.strictObject({
  x: Decimals(0, 1, 3), y: Decimals(0, 1, 3),
  width: Decimals(0.05, 1, 3), height: Decimals(0.05, 1, 3),
}).superRefine((rect, ctx) => {
  if (rect.x + rect.width > 1 + 1e-9) ctx.addIssue({ code: 'custom', path: ['width'], message: 'crop rect must lie inside the frame' })
  if (rect.y + rect.height > 1 + 1e-9) ctx.addIssue({ code: 'custom', path: ['height'], message: 'crop rect must lie inside the frame' })
})
export type CropRect = z.infer<typeof CropRect>
export const FULL_CROP: CropRect = Object.freeze({ x: 0, y: 0, width: 1, height: 1 })

const Crop = Animated(CropRect).superRefine((crop, ctx) => {
  if (!isAnimated(crop)) return
  const aspects = crop.keys.map(key => key.value.width / key.value.height)
  if (Math.max(...aspects) / Math.min(...aspects) > 1.005 + 1e-9) {
    ctx.addIssue({ code: 'custom', path: ['keys'], message: 'crop keys must keep one aspect ratio' })
  }
})

/** The earlier key shapes its segment; outside the key range the endpoint holds. */
export function evaluateAnimated<T extends number | CropRect>(value: Animated<T>, sourceMs: number): T {
  if (!isAnimated(value)) return value as T
  const keys = value.keys
  const first = keys[0]!
  if (sourceMs <= first.t) return first.value
  for (let index = 1; index < keys.length; index++) {
    const to = keys[index]!
    if (sourceMs >= to.t) continue
    const from = keys[index - 1]!
    const fraction = (sourceMs - from.t) / (to.t - from.t)
    const progress = from.ease === 'hold' ? 0 : from.ease === 'easeInOut' ? fraction * fraction * (3 - 2 * fraction) : fraction
    if (typeof from.value === 'number' && typeof to.value === 'number') return (from.value + (to.value - from.value) * progress) as T
    const a = from.value as CropRect
    const b = to.value as CropRect
    return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress,
      width: a.width + (b.width - a.width) * progress, height: a.height + (b.height - a.height) * progress } as T
  }
  return keys.at(-1)!.value
}

/**
 * 0024e: where an overlay clip sits. Fractions of the output frame, so a 4K logo and a 512 px logo
 * behave the same; the height follows the source aspect ratio, so overlays are never stretched.
 */
export const OverlayPlacement = z.strictObject({
  // Centre of the overlay; it may extend past the frame edge and is cropped there
  x: Animated(Decimals(0, 1, 3)),
  y: Animated(Decimals(0, 1, 3)),
  // Width as a fraction of the output width
  width: Animated(Decimals(TIMELINE_LIMITS.overlayMinWidth, 1, 3)),
  opacity: Animated(Decimals(0, 1, 2)),
})
export type OverlayPlacement = z.infer<typeof OverlayPlacement>

/** 0024d: the cut into this clip from the previous one; the two clips overlap by durationMs. */
export const TimelineTransition = z.strictObject({
  // crossfade blends the two shots; dip fades the first to black and the second in from black
  kind: z.enum(['crossfade', 'dip']),
  durationMs: z.int().min(TIMELINE_LIMITS.transitionMinMs).max(TIMELINE_LIMITS.transitionMaxMs),
})
export type TimelineTransition = z.infer<typeof TimelineTransition>

export const TimelineClip = z.strictObject({
  id: Id,
  // Pinned version: regenerating the source node never changes the cut silently
  source: z.strictObject({ nodeId: Id, assetVersionId: Id }),
  startMs: Ms,
  // Range inside the source; for image clips inMs is 0 and outMs is the display duration
  inMs: Ms,
  outMs: Ms,
  // For video clips this is the clip's own soundtrack
  volume: Volume,
  // Timeline milliseconds, so they stay inside the clip's length after speed changes
  fadeInMs: Fade,
  fadeOutMs: Fade,
  // 0024d: playback speed of the source range, pitch preserved; omitted means 1. Not for image clips.
  speed: Speed.optional(),
  // 0024d: video track only, never on the first clip
  transitionIn: TimelineTransition.optional(),
  // 0024e: required on overlay tracks, rejected elsewhere. On overlay clips the fades above also fade the picture.
  overlay: OverlayPlacement.optional(),
  crop: Crop.optional(),
}).superRefine((c, ctx) => {
  if (c.outMs <= c.inMs) ctx.addIssue({ code: 'custom', path: ['outMs'], message: 'outMs must be greater than inMs' })
  else if (c.fadeInMs + c.fadeOutMs > clipDurationMs(c)) ctx.addIssue({ code: 'custom', path: ['fadeOutMs'], message: 'fades must fit inside the clip' })
})
export type TimelineClip = z.infer<typeof TimelineClip>

export const TimelineTrack = z.strictObject({
  id: Id,
  // video is the single main track; overlay tracks (0024e) draw above it with gaps allowed
  kind: z.enum(['video', 'overlay', 'audio']),
  name: z.string().max(100).optional(),
  // muted and volume apply to the sound of the track's clips
  muted: z.boolean(),
  volume: Volume,
  // 0024e: overlay tracks only; hides the picture, sound is still controlled by muted
  hidden: z.boolean().optional(),
  clips: z.array(TimelineClip).max(TIMELINE_LIMITS.clipsPerTrack),
})
export type TimelineTrack = z.infer<typeof TimelineTrack>
export type TimelineTrackKind = TimelineTrack['kind']

/** Longest image display on a track: a logo overlay may run through the whole film, main-track images stay short */
export function imageMaxMs(track: Pick<TimelineTrack, 'kind'>): number {
  return track.kind === 'overlay' ? TIMELINE_LIMITS.maxDurationMs : TIMELINE_LIMITS.imageMaxMs
}

// 0024e: branch on these instead of `kind === 'video'`, which used to imply "everything else is audio"
export const isMainVideoTrack = (track: Pick<TimelineTrack, 'kind'>) => track.kind === 'video'
export const isOverlayTrack = (track: Pick<TimelineTrack, 'kind'>) => track.kind === 'overlay'
export const isAudioTrack = (track: Pick<TimelineTrack, 'kind'>) => track.kind === 'audio'

// 0024d: fonts. Built-in fonts are fetched from resources/fonts/fonts.json (all OFL); projects can add .ttf / .otf font assets.
export const BUILTIN_FONTS = ['noto-sans-sc', 'smiley-sans', 'lxgw-wenkai', 'zcool-kuaile'] as const
export const BuiltinFontId = z.enum(BUILTIN_FONTS)
export type BuiltinFontId = z.infer<typeof BuiltinFontId>
/** Family names inside the bundled files; ASS and FontFace both select fonts by these */
export const BUILTIN_FONT_FAMILIES: Record<BuiltinFontId, string> = {
  'noto-sans-sc': 'Noto Sans SC',
  'smiley-sans': 'Smiley Sans',
  'lxgw-wenkai': 'LXGW WenKai',
  'zcool-kuaile': 'ZCOOL KuaiLe',
}
export const FontRef = z.union([z.strictObject({ builtin: BuiltinFontId }), z.strictObject({ assetVersionId: Id })])
export type FontRef = z.infer<typeof FontRef>
/** Stable map key for a font reference, used to pass resolved font files around */
export function fontKey(font: FontRef): string {
  return 'builtin' in font ? `builtin:${font.builtin}` : `asset:${font.assetVersionId}`
}

export const TextPreset = z.enum(['subtitle', 'variety', 'cinema', 'title'])
export type TextPreset = z.infer<typeof TextPreset>
export const TextPosition = z.enum(['bottom', 'middle', 'top'])
export type TextPosition = z.infer<typeof TextPosition>

/**
 * Preset looks shared by export (ASS) and the editor preview (CSS), so both read the same numbers.
 * Sizes are percentages of the output height; outline and shadow are fractions of the font size;
 * marginPct is the distance from the top or bottom edge as a percentage of the output height.
 */
export const TEXT_PRESETS: Record<TextPreset, {
  font: BuiltinFontId
  sizePct: number
  color: string
  outlineColor: string
  outlineEm: number
  shadowColor: string
  shadowOpacity: number
  shadowEm: number
  position: TextPosition
  marginPct: number
}> = {
  subtitle: { font: 'noto-sans-sc', sizePct: 5.5, color: '#FFFFFF', outlineColor: '#000000', outlineEm: 0.08, shadowColor: '#000000', shadowOpacity: 0, shadowEm: 0, position: 'bottom', marginPct: 7 },
  variety: { font: 'zcool-kuaile', sizePct: 8, color: '#FFE14D', outlineColor: '#3A1C00', outlineEm: 0.14, shadowColor: '#000000', shadowOpacity: 0.6, shadowEm: 0.06, position: 'bottom', marginPct: 10 },
  cinema: { font: 'lxgw-wenkai', sizePct: 4.5, color: '#FFFFFF', outlineColor: '#000000', outlineEm: 0, shadowColor: '#000000', shadowOpacity: 0.7, shadowEm: 0.05, position: 'bottom', marginPct: 6 },
  title: { font: 'smiley-sans', sizePct: 12, color: '#FFFFFF', outlineColor: '#000000', outlineEm: 0.04, shadowColor: '#000000', shadowOpacity: 0, shadowEm: 0, position: 'middle', marginPct: 0 },
}

export const TextStyle = z.strictObject({
  preset: TextPreset,
  // Omitted fields take the preset's values
  font: FontRef.optional(),
  sizePct: z.number().min(TIMELINE_LIMITS.textMinSizePct).max(TIMELINE_LIMITS.textMaxSizePct).optional(),
  color: Color.optional(),
  position: TextPosition.optional(),
})
export type TextStyle = z.infer<typeof TextStyle>

export const TextClip = z.strictObject({
  id: Id,
  // Absolute timeline time like audio clips; the editor's caption linkage moves text with its video clip
  startMs: Ms,
  durationMs: z.int().min(TIMELINE_LIMITS.textMinMs).max(TIMELINE_LIMITS.maxDurationMs),
  // Lines break only at \n, never automatically, so the preview and the export break identically
  text: z.string().min(1).max(TIMELINE_LIMITS.textMaxChars)
    .refine(text => text.trim().length > 0, { message: 'text must not be blank' })
    // Control characters other than \n would be interpreted differently by ASS and the browser
    .refine(text => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text), { message: 'text may contain line breaks but no other control characters' })
    .refine(text => text.split('\n').length <= TIMELINE_LIMITS.textMaxLines, { message: `at most ${TIMELINE_LIMITS.textMaxLines} lines` }),
  style: TextStyle,
  fadeInMs: Fade,
  fadeOutMs: Fade,
}).superRefine((c, ctx) => {
  if (c.fadeInMs + c.fadeOutMs > c.durationMs) ctx.addIssue({ code: 'custom', path: ['fadeOutMs'], message: 'fades must fit inside the text clip' })
})
export type TextClip = z.infer<typeof TextClip>

export const TextTrack = z.strictObject({
  id: Id,
  name: z.string().max(100).optional(),
  hidden: z.boolean(),
  clips: z.array(TextClip).max(TIMELINE_LIMITS.clipsPerTrack),
})
export type TextTrack = z.infer<typeof TextTrack>

export const TimelineOutput = z.strictObject({
  width: Even(64, 3840),
  height: Even(64, 2160),
  fps: z.int().min(1).max(60),
})
export type TimelineOutput = z.infer<typeof TimelineOutput>

/** Output used when a timeline has text or overlays but no main video clips: a black background */
export const FALLBACK_OUTPUT: TimelineOutput = { width: 1920, height: 1080, fps: 30 }

/** Length on the timeline: the source range played at the clip's speed */
export function clipDurationMs(clip: Pick<TimelineClip, 'inMs' | 'outMs'> & { speed?: number | undefined }): number {
  return Math.round((clip.outMs - clip.inMs) / (clip.speed ?? 1))
}

export function clipEndMs(clip: Pick<TimelineClip, 'startMs' | 'inMs' | 'outMs'> & { speed?: number | undefined }): number {
  return clip.startMs + clipDurationMs(clip)
}

/** Source position shown at a timeline position; export and preview both map time through this. */
export function sourceTimeAt(clip: Pick<TimelineClip, 'startMs' | 'inMs'> & { speed?: number | undefined }, timelineMs: number): number {
  return clip.inMs + (timelineMs - clip.startMs) * (clip.speed ?? 1)
}

/** Text tracks that export and preview draw: not hidden and not empty */
export function visibleTextTracks(doc: Pick<TimelineDoc, 'textTracks'>): TextTrack[] {
  return (doc.textTracks ?? []).filter(track => !track.hidden && track.clips.length > 0)
}

/** Overlay tracks that export and preview draw, bottom to top: not hidden and not empty */
export function overlayTracks(doc: Pick<TimelineDoc, 'tracks'>): TimelineTrack[] {
  return doc.tracks.filter(track => isOverlayTrack(track) && !track.hidden && track.clips.length > 0)
}

/**
 * Picture opacity times its linear fades; 0 outside the clip. A caller that already sampled placement
 * can reuse that value, or pass 1 to obtain the fade factor without evaluating the opacity curve.
 */
export function overlayOpacityAt(clip: Pick<TimelineClip, 'overlay' | 'startMs' | 'inMs' | 'outMs' | 'speed' | 'fadeInMs' | 'fadeOutMs'>, timelineMs: number, sampledOpacity?: number): number {
  const local = timelineMs - clip.startMs
  const length = clipDurationMs(clip)
  if (!clip.overlay || local < 0 || local >= length) return 0
  const fadeIn = clip.fadeInMs ? Math.min(1, local / clip.fadeInMs) : 1
  const fadeOut = clip.fadeOutMs ? Math.min(1, (length - local) / clip.fadeOutMs) : 1
  return (sampledOpacity ?? evaluateAnimated(clip.overlay.opacity, sourceTimeAt(clip, timelineMs))) * fadeIn * fadeOut
}

/**
 * Pixel rectangle of an overlay in the output. Width and height are even (yuv420p) and at least 2;
 * x / y are the top-left corner and may be negative or past the frame when the overlay is cropped.
 * Export scales to exactly this size; the preview uses the same numbers as percentages.
 */
export function overlayRect(placement: OverlayPlacement, sourceAspect: number, output: Pick<TimelineOutput, 'width' | 'height'>, sourceMs = 0) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const width = even(evaluateAnimated(placement.width, sourceMs) * output.width)
  const height = even(width / sourceAspect)
  return { x: Math.round(evaluateAnimated(placement.x, sourceMs) * output.width - width / 2), y: Math.round(evaluateAnimated(placement.y, sourceMs) * output.height - height / 2), width, height }
}

/** Crop coordinates use rotated source pixels; rect is the fitted picture in output pixels. */
export function clipTransformAt(clip: Pick<TimelineClip, 'crop' | 'overlay'>, sourceMs: number,
  output: Pick<TimelineOutput, 'width' | 'height'>, sourceSize: { width: number; height: number }) {
  const value = evaluateAnimated(clip.crop ?? FULL_CROP, sourceMs)
  const crop = { x: value.x * sourceSize.width, y: value.y * sourceSize.height,
    width: value.width * sourceSize.width, height: value.height * sourceSize.height }
  const scale = Math.min(output.width / crop.width, output.height / crop.height)
  const width = crop.width * scale
  const height = crop.height * scale
  return { crop, rect: clip.overlay ? overlayRect(clip.overlay, crop.width / crop.height, output, sourceMs)
    : { x: (output.width - width) / 2, y: (output.height - height) / 2, width, height },
  opacity: clip.overlay ? evaluateAnimated(clip.overlay.opacity, sourceMs) : 1 }
}

export function textClipEndMs(clip: Pick<TextClip, 'startMs' | 'durationMs'>): number {
  return clip.startMs + clip.durationMs
}

/**
 * Fades actually applied to a clip's sound: across a transition the outgoing clip fades out and the
 * incoming clip fades in for at least the transition's length. The two may overlap; gains multiply.
 */
export function effectiveFades(track: Pick<TimelineTrack, 'kind' | 'clips'>, index: number): { fadeInMs: number; fadeOutMs: number } {
  const clip = track.clips[index]!
  if (track.kind !== 'video') return { fadeInMs: clip.fadeInMs, fadeOutMs: clip.fadeOutMs }
  return {
    fadeInMs: Math.max(clip.fadeInMs, clip.transitionIn?.durationMs ?? 0),
    fadeOutMs: Math.max(clip.fadeOutMs, track.clips[index + 1]?.transitionIn?.durationMs ?? 0),
  }
}

/** Length of the whole timeline: the latest clip end across all tracks, muted and hidden ones included */
export function timelineDurationMs(doc: {
  tracks: readonly { clips: readonly (Pick<TimelineClip, 'startMs' | 'inMs' | 'outMs'> & { speed?: number | undefined })[] }[]
  textTracks?: readonly { clips: readonly Pick<TextClip, 'startMs' | 'durationMs'>[] }[] | undefined
}): number {
  return Math.max(0, ...doc.tracks.flatMap(t => t.clips.map(clipEndMs)), ...(doc.textTracks ?? []).flatMap(t => t.clips.map(textClipEndMs)))
}

// Structural rules only. Rules that need asset metadata (source belongs to the project, kind matches
// the track, outMs within the asset duration, image display range, font assets) are checked where assets are known.
export const TimelineDoc = z.strictObject({
  version: z.literal(1),
  // Omitted: size and frame rate of the first main video clip; without one, FALLBACK_OUTPUT when there
  // are overlays or text, otherwise an audio export
  output: TimelineOutput.optional(),
  // The main video track, then overlay tracks bottom to top, then audio tracks in display order
  tracks: z.array(TimelineTrack),
  // 0024d: kept apart from tracks because every media clip has a source and text clips do not
  textTracks: z.array(TextTrack).max(TIMELINE_LIMITS.textTracks).optional(),
}).superRefine((doc, ctx) => {
  const count = (kind: TimelineTrackKind) => doc.tracks.filter(t => t.kind === kind).length
  if (count('video') > TIMELINE_LIMITS.videoTracks) ctx.addIssue({ code: 'custom', path: ['tracks'], message: `at most ${TIMELINE_LIMITS.videoTracks} video track(s)` })
  if (count('overlay') > TIMELINE_LIMITS.overlayTracks) ctx.addIssue({ code: 'custom', path: ['tracks'], message: `at most ${TIMELINE_LIMITS.overlayTracks} overlay tracks` })
  if (count('audio') > TIMELINE_LIMITS.audioTracks) ctx.addIssue({ code: 'custom', path: ['tracks'], message: `at most ${TIMELINE_LIMITS.audioTracks} audio tracks` })
  const rank: Record<TimelineTrackKind, number> = { video: 0, overlay: 1, audio: 2 }
  if (doc.tracks.some((t, i) => i > 0 && rank[t.kind] < rank[doc.tracks[i - 1]!.kind])) {
    ctx.addIssue({ code: 'custom', path: ['tracks'], message: 'tracks must be ordered: video, then overlay, then audio' })
  }

  const ids = new Set<string>()
  const unique = (id: string, path: (string | number)[]) => {
    if (ids.has(id)) ctx.addIssue({ code: 'custom', path, message: 'duplicate id' })
    ids.add(id)
  }
  doc.tracks.forEach((track, ti) => {
    unique(track.id, ['tracks', ti, 'id'])
    const overlay = isOverlayTrack(track)
    if (track.hidden !== undefined && !overlay) ctx.addIssue({ code: 'custom', path: ['tracks', ti, 'hidden'], message: 'only overlay tracks can be hidden' })
    if (overlay && track.clips.length > TIMELINE_LIMITS.overlayClipsPerTrack) {
      ctx.addIssue({ code: 'custom', path: ['tracks', ti, 'clips'], message: `at most ${TIMELINE_LIMITS.overlayClipsPerTrack} clips per overlay track` })
    }
    track.clips.forEach((clip, ci) => {
      const path = ['tracks', ti, 'clips', ci]
      unique(clip.id, [...path, 'id'])
      if (overlay && !clip.overlay) ctx.addIssue({ code: 'custom', path: [...path, 'overlay'], message: 'overlay clips need an overlay placement' })
      if (!overlay && clip.overlay) ctx.addIssue({ code: 'custom', path: [...path, 'overlay'], message: 'only overlay clips have an overlay placement' })
      if (track.kind === 'audio' && clip.crop) ctx.addIssue({ code: 'custom', path: [...path, 'crop'], message: 'audio clips cannot have a crop' })
      const previous = ci === 0 ? undefined : track.clips[ci - 1]!
      const prevEnd = previous ? clipEndMs(previous) : 0
      if (track.kind === 'video') {
        const overlap = clip.transitionIn?.durationMs ?? 0
        if (clip.transitionIn && !previous) ctx.addIssue({ code: 'custom', path: [...path, 'transitionIn'], message: 'the first clip cannot have a transition' })
        // Video clips butt end to end from 0; a transition overlaps the previous clip by its duration
        else if (clip.startMs !== prevEnd - overlap) ctx.addIssue({ code: 'custom', path: [...path, 'startMs'], message: 'video clips must start where the previous clip ends, minus any transition' })
        if (previous && overlap) {
          const length = clipDurationMs(clip)
          const outgoing = track.clips[ci + 1]?.transitionIn?.durationMs ?? 0
          if (overlap > clipDurationMs(previous) || overlap + outgoing > length) {
            ctx.addIssue({ code: 'custom', path: [...path, 'transitionIn', 'durationMs'], message: 'transitions must fit inside both clips' })
          }
        }
      } else {
        if (clip.transitionIn) ctx.addIssue({ code: 'custom', path: [...path, 'transitionIn'], message: 'transitions are only for main video clips' })
        // Audio and overlay clips are stored sorted by startMs, may leave gaps and must not overlap within a track
        if (previous && clip.startMs < prevEnd) ctx.addIssue({ code: 'custom', path: [...path, 'startMs'], message: `${track.kind} clips must be sorted and must not overlap` })
      }
    })
  })
  doc.textTracks?.forEach((track, ti) => {
    unique(track.id, ['textTracks', ti, 'id'])
    track.clips.forEach((clip, ci) => {
      unique(clip.id, ['textTracks', ti, 'clips', ci, 'id'])
      if (ci > 0 && clip.startMs < textClipEndMs(track.clips[ci - 1]!)) {
        ctx.addIssue({ code: 'custom', path: ['textTracks', ti, 'clips', ci, 'startMs'], message: 'text clips must be sorted and must not overlap' })
      }
    })
  })
  if (timelineDurationMs(doc) > TIMELINE_LIMITS.maxDurationMs) ctx.addIssue({ code: 'custom', path: ['tracks'], message: 'timeline is too long' })
})
export type TimelineDoc = z.infer<typeof TimelineDoc>

// 0024: links an exported video / audio node to the timeline revision it was rendered from
export const ExportOf = z.strictObject({ timelineNodeId: Id, timelineRevision: Revision })
export type ExportOf = z.infer<typeof ExportOf>
