import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimelineClip, TimelineDoc } from '@vis/protocol'
import type { MediaSize } from './transform'
import type { EditorPartProps } from '../types'
import { createMediaPlayer } from './media'

class Media extends EventTarget {
  style = { visibility: '', opacity: '', mixBlendMode: '', transform: '', clipPath: '' }
  videoWidth = 1920
  videoHeight = 1080
  parentElement = { style: {}, parentElement: { append() {} } }
  playbackRate = 1
  preservesPitch = false
  readyState = 4
  seeking = false
  paused = true
  muted = false
  error: unknown = null
  preload = ''
  private time = 0
  private attributes = new Map<string, string>()
  seeks: number[] = []
  get currentTime() { return this.time }
  set currentTime(value: number) { this.time = value; this.seeks.push(value) }
  get src() { return this.attributes.get('src') ?? '' }
  set src(value: string) { this.attributes.set('src', value) }
  getAttribute(name: string) { return this.attributes.get(name) ?? null }
  removeAttribute(name: string) { this.attributes.delete(name) }
  load() {}
  remove() {}
  pause() { this.paused = true }
  async play() { this.paused = false }
}
class Image extends Media {
  autoLoad = true
  currentSrc = ''
  complete = true
  override get src() { return super.src }
  override set src(value: string) {
    super.src = value
    if (this.autoLoad) this.currentSrc = value
  }
  videoWidth = 0
  videoHeight = 0
  naturalWidth = 1920
  naturalHeight = 1080
}
const clip = (id: string, startMs: number): TimelineClip => ({ id, startMs, inMs: 100, outMs: 1100, source: { nodeId: id, assetVersionId: id }, volume: 1, fadeInMs: 0, fadeOutMs: 0 })

function setup(kind: 'video' | 'audio' | 'image' = 'video', readyState = 4, stored: Partial<MediaSize> = { width: 1920, height: 1080 }) {
  vi.useFakeTimers()
  const frames = new Map<number, FrameRequestCallback>()
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  const audios: Media[] = []
  vi.stubGlobal('document', { createElement: (kind: string) => {
    if (kind === 'div') return { className: '', append(element: Media) { element.parentElement = this as unknown as Media['parentElement'] }, style: {}, remove() {} }
    const media = new Media(); audios.push(media); return media
  } })
  let position = 0
  let playing = false
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach(listener => listener())
  const gain = () => ({ gain: { setValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), linearRampToValueAtTime: vi.fn() }, connect: vi.fn().mockReturnThis(), disconnect: vi.fn() })
  const context = { currentTime: 0, destination: {}, createGain: gain, createMediaElementSource: gain }
  const clock = {
    now: () => position, playing: () => playing, context: () => context,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    play: () => { playing = true; emit() }, pause: () => { playing = false; emit() }, seek: (ms: number) => { position = ms; emit() },
  }
  const doc: TimelineDoc = { version: 1, tracks: [{ id: 'track', kind: kind === 'audio' ? 'audio' : 'video', muted: false, volume: 1, clips: [clip('a', 0), clip('b', 1000)] }] }
  const parts = { output: { width: 1920, height: 1080 }, draft: { doc }, clock, host: { nodes: [], assetUrl: (id: string) => `/assets/${id}` } } as unknown as EditorPartProps & { output: MediaSize }
  const videos = [new Media(), new Media()]
  videos.forEach(video => { video.readyState = readyState; if (!readyState) { video.videoWidth = 0; video.videoHeight = 0 } })
  const image = new Image()
  const changed = vi.fn()
  const imageB = new Image()
  const sized = vi.fn()
  const player = createMediaPlayer(videos as unknown as HTMLVideoElement[], [image, imageB] as unknown as HTMLImageElement[], () => parts, changed, () => ({ kind, ...stored }), sized)
  const step = (ms: number) => {
    position = ms
    const pending = [...frames.values()]
    frames.clear()
    pending.forEach(callback => callback(ms))
  }
  return { sized, frames, clock, videos, audios, image, imageB, changed, parts, player, step }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Timeline media player', () => {
  it('hides a reused image with stale natural dimensions through preload and promotion until its assigned source loads', () => {
    const { parts, image, imageB, clock, player, sized } = setup('image')
    image.autoLoad = false
    parts.draft.doc.tracks[0]!.clips.push(clip('c', 2000))
    clock.seek(1000)
    expect(imageB.style.visibility).toBe('visible')
    expect(image.src).toBe('/assets/c')
    expect(image.currentSrc).toBe('/assets/a')
    expect(image.naturalWidth).toBe(1920)
    expect(image.style.visibility).toBe('hidden')
    clock.seek(2000)
    expect(image.style.visibility).toBe('hidden')
    image.currentSrc = image.src
    image.naturalWidth = 1080
    image.naturalHeight = 1920
    image.dispatchEvent(new Event('load'))
    expect(sized).toHaveBeenCalledWith('c', { width: 1080, height: 1920 })
    expect(image.style.visibility).toBe('visible')
    expect(image.parentElement.style).toMatchObject({ width: '31.640625%', height: '100%' })
    player.dispose()
  })

  it('hides unknown dimensions and prepares a decoded portrait spare before promotion', () => {
    const { videos, clock, player, sized } = setup('video', 0, {})
    expect(videos.map(video => video.style.visibility)).toEqual(['hidden', 'hidden'])
    expect(videos[0]!.style.transform).toBe('')
    const spare = videos[1]!
    spare.readyState = 4
    spare.videoWidth = 1080
    spare.videoHeight = 1920
    spare.dispatchEvent(new Event('loadedmetadata'))
    expect(sized).toHaveBeenCalledWith('b', { width: 1080, height: 1920 })
    expect(spare.style.visibility).toBe('hidden')
    expect(spare.parentElement.style).toMatchObject({ width: '31.640625%', height: '100%' })
    expect(spare.style.transform).toBe('translate(0%, 0%) scale(1, 1)')
    clock.seek(1000)
    expect(spare.style.visibility).toBe('visible')
    expect(spare.parentElement.style).toMatchObject({ width: '31.640625%', height: '100%' })
    player.dispose()
  })

  it.each(['video', 'image'] as const)('paints %s crops on paused seeks and rAF before promoting a transformed spare', kind => {
    const { parts, clock, videos, image, imageB, step, player, changed } = setup(kind)
    const clips = parts.draft.doc.tracks[0]!.clips
    clips[0] = { ...clips[0]!, crop: { keys: [
      { t: 100, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'linear' },
      { t: 1100, value: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, ease: 'hold' },
    ] } }
    clips[1] = { ...clips[1]!, crop: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }
    player.update()
    const [current, spare] = kind === 'video' ? videos : [image, imageB]
    expect(spare!.style.visibility).toBe('hidden')
    expect(spare!.style.transform).toBe('translate(-50%, -50%) scale(2, 2)')
    clock.seek(500)
    expect(current!.style.transform).toContain('scale(1.3333333333333333, 1.3333333333333333)')
    clock.play()
    const notifications = changed.mock.calls.length
    step(700)
    expect(current!.style.transform).toContain('scale(1.5384615384615385, 1.5384615384615385)')
    expect(changed).toHaveBeenCalledTimes(notifications)
    const promotion = vi.fn()
    Object.defineProperty(spare!.style, 'visibility', { set(value: string) {
      if (value === 'visible') promotion(spare!.style.transform)
    } })
    step(1000)
    expect(promotion).toHaveBeenCalledWith('translate(-50%, -50%) scale(2, 2)')
    player.dispose()
  })

  it('never treats overlay pictures as main video or audio, including after the main track ends', () => {
    const { parts, videos, audios, clock, player, changed } = setup()
    parts.draft.doc.tracks.push({ id: 'overlay', kind: 'overlay', muted: false, volume: 1, clips: [{
      ...clip('logo', 0), inMs: 0, outMs: 5000, overlay: { x: 0.5, y: 0.5, width: 0.25, opacity: 1 },
    }] })
    player.update()
    clock.seek(2500)
    expect(videos.every(video => video.style.visibility === 'hidden')).toBe(true)
    expect(audios).toHaveLength(0)
    expect(changed.mock.lastCall?.[0]).toMatchObject({ audioIds: [], loading: false, unavailable: false })
    expect(changed.mock.lastCall?.[0]).not.toHaveProperty('clipId')
    player.dispose()
  })
  it.each(['video', 'audio'] as const)('maps %s seeks at speed while preserving pitch', kind => {
    const { parts, videos, audios, clock, player } = setup(kind)
    parts.draft.doc.tracks[0]!.clips[0]!.speed = 2
    player.update()
    clock.seek(200)
    const element = kind === 'video' ? videos[0]! : audios[0]!
    expect(element.currentTime).toBe(0.5)
    expect(element.playbackRate).toBe(2)
    expect(element.preservesPitch).toBe(true)
    player.dispose()
  })
  it.each(['video', 'image'] as const)('shows both %s elements in a transition and plays both videos', kind => {
    const { parts, videos, image, imageB, clock, player } = setup(kind)
    const incoming = parts.draft.doc.tracks[0]!.clips[1]!
    incoming.startMs = 500
    incoming.transitionIn = { kind: 'crossfade', durationMs: 500 }
    player.update()
    clock.seek(750)
    clock.play()
    const elements = kind === 'video' ? videos : [image, imageB]
    expect(elements.map(element => element.style.visibility)).toEqual(['visible', 'visible'])
    expect(elements.map(element => Number(element.style.opacity))).toEqual([0.5, 0.5])
    if (kind === 'video') expect(videos.map(video => video.paused)).toEqual([false, false])
    clock.seek(1000)
    expect(elements.filter(element => element.style.visibility === 'visible')).toHaveLength(1)
    player.dispose()
  })
  it('prepares a third video before a back-to-back overlap without disturbing the playing pair', () => {
    const { parts, videos, audios, clock, player, step } = setup()
    const clips = parts.draft.doc.tracks[0]!.clips
    clips[1]!.startMs = 500
    clips[1]!.transitionIn = { kind: 'crossfade', durationMs: 500 }
    clips.push({ ...clip('c', 1000), transitionIn: { kind: 'dip', durationMs: 500 } })
    player.update()
    clock.seek(750)
    clock.play()
    expect(videos.map(video => video.paused)).toEqual([false, false])
    const spare = audios[0]!
    expect(spare.src).toBe('/assets/c')
    expect(spare.currentTime).toBe(0.1)
    expect(spare.paused).toBe(true)
    const seeks = spare.seeks.length
    step(1000)
    expect(spare.style.visibility).toBe('visible')
    expect(spare.paused).toBe(false)
    expect(spare.seeks).toHaveLength(seeks)
    player.dispose()
  })
  it('switches to a prepared spare without seeking it again', () => {
    const { clock, videos, step, player } = setup()
    clock.play()
    for (let ms = 200; ms < 1000; ms += 200) step(ms)
    const spare = videos[1]!
    expect(spare.currentTime).toBe(0.1)
    const seeks = spare.seeks.length
    step(1000)
    expect(spare.style.visibility).toBe('visible')
    expect(spare.seeks).toHaveLength(seeks)
    player.dispose()
  })

  it('schedules no frames while paused, including after a seek', () => {
    const { frames, clock, player } = setup()
    expect(frames.size).toBe(0)
    clock.play()
    expect(frames.size).toBe(1)
    clock.pause()
    expect(frames.size).toBe(0)
    clock.seek(500)
    expect(frames.size).toBe(0)
    player.dispose()
  })

  it.each(['trim', 'move', 'source'] as const)('realigns a prepared spare after a %s edit while paused', change => {
    const { parts, videos, player } = setup()
    const spare = videos[1]!
    const seeks = spare.seeks.length
    const next = structuredClone(parts.draft.doc)
    const pending = next.tracks[0]!.clips[1]!
    if (change === 'trim') pending.inMs += 10
    if (change === 'move') pending.startMs += 10
    if (change === 'source') pending.source.assetVersionId = 'replacement'
    parts.draft.doc = next
    player.update()
    expect(spare.seeks).toHaveLength(seeks + 1)
    expect(spare.currentTime).toBe(pending.inMs / 1000)
    if (change === 'source') expect(spare.src).toBe('/assets/replacement')
    player.dispose()
  })

  it.each([false, true])('realigns even a sub-tolerance seek when playing is %s', playing => {
    const { videos, clock, player } = setup()
    if (playing) clock.play()
    const current = videos[0]!
    const seeks = current.seeks.length
    clock.seek(20)
    expect(current.seeks).toHaveLength(seeks + 1)
    expect(current.currentTime).toBe(0.12)
    player.dispose()
  })

  it.each([false, true])('realigns a same-position seek when playing is %s', playing => {
    const { videos, clock, player } = setup()
    if (playing) clock.play()
    const current = videos[0]!
    current.currentTime = 0.15
    const seeks = current.seeks.length
    clock.seek(clock.now())
    expect(current.seeks).toHaveLength(seeks + 1)
    expect(current.currentTime).toBe(0.1)
    player.dispose()
  })

  it('aligns metadata against the latest trim and recovers a paused seek through readiness events', () => {
    const { videos, parts, player, changed, frames } = setup('video', 0)
    const next = structuredClone(parts.draft.doc)
    next.tracks[0]!.clips[0]!.inMs = 200
    parts.draft.doc = next
    player.update()
    const current = videos[0]!
    current.readyState = 1
    current.dispatchEvent(new Event('loadedmetadata'))
    expect(current.currentTime).toBe(0.2)
    vi.advanceTimersByTime(299)
    expect(changed.mock.lastCall?.[0].loading).toBe(false)
    vi.advanceTimersByTime(1)
    expect(changed.mock.lastCall?.[0].loading).toBe(true)
    current.readyState = 4
    current.seeking = true
    current.dispatchEvent(new Event('loadeddata'))
    expect(changed.mock.lastCall?.[0].loading).toBe(true)
    current.seeking = false
    current.dispatchEvent(new Event('seeked'))
    expect(changed.mock.lastCall?.[0].loading).toBe(false)
    current.error = new Error('Unavailable fixture')
    current.dispatchEvent(new Event('error'))
    expect(changed.mock.lastCall?.[0].unavailable).toBe(true)
    current.error = null
    current.dispatchEvent(new Event('canplay'))
    expect(changed.mock.lastCall?.[0].unavailable).toBe(false)
    expect(frames.size).toBe(0)
    player.dispose()
  })

  it.each(['audio', 'image'] as const)('updates paused %s readiness without polling', kind => {
    const { audios, image, player, changed, frames } = setup(kind)
    const element = kind === 'audio' ? audios[0]! : image
    if (kind === 'audio') element.readyState = 1
    else image.complete = false
    player.update()
    vi.advanceTimersByTime(300)
    expect(changed.mock.lastCall?.[0].loading).toBe(true)
    if (kind === 'audio') element.readyState = 4
    else image.complete = true
    element.dispatchEvent(new Event(kind === 'audio' ? 'canplay' : 'load'))
    expect(changed.mock.lastCall?.[0].loading).toBe(false)
    if (kind === 'audio') element.error = new Error('Unavailable fixture')
    else image.naturalWidth = 0
    element.dispatchEvent(new Event('error'))
    expect(changed.mock.lastCall?.[0].unavailable).toBe(true)
    expect(frames.size).toBe(0)
    player.dispose()
  })

  it('releases pending frames, loading timers and readiness listeners on disposal', () => {
    const { videos, clock, player, changed, frames } = setup('video', 0)
    clock.play()
    expect(frames.size).toBe(1)
    player.dispose()
    const notifications = changed.mock.calls.length
    videos[0]!.dispatchEvent(new Event('loadeddata'))
    clock.seek(500)
    vi.advanceTimersByTime(1000)
    expect(changed).toHaveBeenCalledTimes(notifications)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rearms an early loading timeout until the paused frame has waited 300 ms', () => {
    const { player, changed, frames } = setup('video', 0)
    const now = vi.spyOn(performance, 'now').mockReturnValue(299)
    vi.advanceTimersByTime(300)
    expect(changed.mock.lastCall?.[0].loading).toBe(false)
    now.mockReturnValue(300)
    vi.advanceTimersByTime(1)
    expect(changed.mock.lastCall?.[0].loading).toBe(true)
    expect(frames.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    player.dispose()
  })
})
