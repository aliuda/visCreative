import { isAudioTrack, isMainVideoTrack, type TimelineClip } from '@vis/protocol'
import type { EditorPartProps } from '../types'
import { subscribePlaybackFrames, type AudioClock } from '../player'
import { activeClip, nextVideoClip, upcomingClips, visualClips } from './model'
import type { AssetInfo } from '../model/resources'
import { mediaSize, paintTransform, writeStyle, type MediaSize } from './transform'
import { alignMedia, playMedia, releaseMedia, type Sound } from './playback'

export function createMediaPlayer(
  initialVideos: readonly HTMLVideoElement[],
  initialImages: readonly HTMLImageElement[],
  get: () => EditorPartProps & { output: MediaSize },
  onChange: (state: { clipId?: string; audioIds: string[]; loading: boolean; unavailable: boolean }) => void,
  assetInfo: (id: string) => AssetInfo | undefined,
  onSize?: (id: string, size: MediaSize) => void,
) {
  const videos = [...initialVideos]
  const images = [...initialImages]
  const videoSounds = videos.map(element => ({ element }) as Sound)
  const extraElements: (HTMLVideoElement | HTMLImageElement)[] = []
  const extraContainers: HTMLDivElement[] = []
  const imageListeners: (() => void)[] = []
  const audio = new Map<string, Sound>()
  const assigned = new Map<HTMLVideoElement, string>()
  const assignedClips = new WeakMap<HTMLVideoElement | HTMLImageElement, TimelineClip>()
  const assignedImages = new Map<HTMLImageElement, string>()
  let loadingTimer: ReturnType<typeof setTimeout> | undefined
  let loadingSince: number | undefined
  let lastState = ''
  let previousPosition = 0
  let disposed = false
  const isImage = (clip: TimelineClip) => {
    const kind = assetInfo(clip.source.assetVersionId)?.kind
    if (kind) return kind === 'image'
    const node = get().host.nodes.find(node => node.nodeId === clip.source.nodeId)
    return node?.kind === 'image' || node?.slots.some(slot => slot.content.type === 'asset' && slot.content.assetVersionId === clip.source.assetVersionId && slot.content.mime.startsWith('image/'))
  }
  const listen = (element: EventTarget, events: string[]) => {
    const changed = () => {
      const media = element as HTMLVideoElement | HTMLImageElement
      const clip = assignedClips.get(media)
      const size = mediaSize(media)
      if (clip && size) onSize?.(clip.source.assetVersionId, size)
      tick()
    }
    events.forEach(event => element.addEventListener(event, changed))
    return () => events.forEach(event => element.removeEventListener(event, changed))
  }
  const listenMedia = (entry: Sound) => {
    entry.unlisten = listen(entry.element, ['loadedmetadata', 'loadeddata', 'seeked', 'canplay', 'error'])
  }
  const appendPicture = (element: HTMLVideoElement | HTMLImageElement, initial: HTMLElement) => {
    const container = document.createElement('div')
    container.className = 'vis-tl-picture'
    container.append(element)
    initial.parentElement?.parentElement?.append(container)
    extraElements.push(element)
    extraContainers.push(container)
  }
  const prepareVideo = (clip: TimelineClip, preferred: number) => {
    const element = videos.find(video => assigned.get(video) === clip.id) ?? videos[preferred]!
    const entry = videoSounds.find(sound => sound.element === element)!
    const src = get().host.assetUrl(clip.source.assetVersionId)
    if (assigned.get(element) !== clip.id || element.getAttribute('src') !== src) {
      element.pause()
      assigned.set(element, clip.id)
      entry.alignment = undefined
      if (element.getAttribute('src') !== src) {
        element.src = src
        element.load()
      }
      entry.signature = undefined
    }
    assignedClips.set(element, clip)
    return element
  }
  const tick = (force = false) => {
    if (disposed) return
    const { draft, clock, host, output } = get()
    const position = clock.now()
    force ||= Math.abs(position - previousPosition) > 250
    previousPosition = position
    const videoTrack = draft.doc.tracks.find(isMainVideoTrack)
    const paint = (element: HTMLVideoElement | HTMLImageElement, clip: TimelineClip, at: number) => {
      return element.parentElement ? paintTransform(element.parentElement, element, clip, at, output, mediaSize(element, assetInfo(clip.source.assetVersionId))) : false
    }
    const current = activeClip(videoTrack, position)
    const next = nextVideoClip(videoTrack, position)
    const visible = visualClips(videoTrack, position)
    // Back-to-back overlaps occupy both original elements until the next cut starts.
    // A third spare lets that incoming shot load and seek while the current pair still plays.
    if (visible.filter(item => !isImage(item.clip)).length === videos.length && next && !isImage(next) && videos.length === initialVideos.length) {
      const element = document.createElement('video')
      element.playsInline = true
      element.preload = 'auto'
      element.style.visibility = 'hidden'
      appendPicture(element, initialVideos[0]!)
      const entry: Sound = { element }
      listenMedia(entry)
      videos.push(element)
      videoSounds.push(entry)
    }
    if (visible.filter(item => isImage(item.clip)).length === images.length && next && isImage(next) && images.length === initialImages.length) {
      const element = document.createElement('img')
      element.alt = ''
      element.style.visibility = 'hidden'
      appendPicture(element, initialImages[0]!)
      images.push(element)
      imageListeners.push(listen(element, ['load', 'error']))
    }
    const activeVideos = new Map<HTMLVideoElement, typeof visible[number]>()
    const activeImages = new Map<HTMLImageElement, typeof visible[number]>()
    for (const item of visible) {
      if (isImage(item.clip)) {
        const image = images.find(image => assignedImages.get(image) === item.clip.id) ?? images.find(image => !activeImages.has(image))!
        assignedImages.set(image, item.clip.id)
        assignedClips.set(image, item.clip)
        const src = host.assetUrl(item.clip.source.assetVersionId)
        if (image.getAttribute('src') !== src) image.src = src
        activeImages.set(image, item)
      } else {
        const free = videos.findIndex(video => !activeVideos.has(video) && !visible.some(item => assigned.get(video) === item.clip.id))
        const element = prepareVideo(item.clip, free < 0 ? videos.findIndex(video => !activeVideos.has(video)) : free)
        activeVideos.set(element, item)
      }
    }
    if (next && !isImage(next) && activeVideos.size < videos.length) {
      const spare = videos.findIndex(video => !activeVideos.has(video))
      const pending = prepareVideo(next, spare)
      if (!activeVideos.has(pending)) {
        paint(pending, next, next.startMs)
        pending.pause()
        alignMedia(videoSounds.find(entry => entry.element === pending)!, next, next.startMs)
      }
    }
    for (const entry of videoSounds) {
      const item = activeVideos.get(entry.element as HTMLVideoElement)
      const known = item && paint(entry.element as HTMLVideoElement, item.clip, position)
      writeStyle(entry.element.style, 'visibility', known ? 'visible' : 'hidden')
      writeStyle(entry.element.style, 'opacity', String(item?.opacity ?? 0))
      if (entry.element.parentElement) writeStyle(entry.element.parentElement.style, 'mixBlendMode', item?.blend ? 'plus-lighter' : 'normal')
      if (item && videoTrack) playMedia(entry, item.clip, videoTrack, position, clock as AudioClock, force)
      else entry.element.pause()
    }
    if (next && isImage(next) && activeImages.size < images.length) {
      const image = images.find(image => !activeImages.has(image))!
      assignedImages.set(image, next.id)
      assignedClips.set(image, next)
      const src = host.assetUrl(next.source.assetVersionId)
      if (image.getAttribute('src') !== src) image.src = src
      paint(image, next, next.startMs)
    }
    for (const image of images) {
      const item = activeImages.get(image)
      const known = item && paint(image, item.clip, position)
      writeStyle(image.style, 'visibility', known ? 'visible' : 'hidden')
      writeStyle(image.style, 'opacity', String(item?.opacity ?? 0))
      if (image.parentElement) writeStyle(image.parentElement.style, 'mixBlendMode', item?.blend ? 'plus-lighter' : 'normal')
    }
    const sounding = upcomingClips(draft.doc, position).filter(({ track }) => isAudioTrack(track))
    const keep = new Set(sounding.map(({ clip }) => clip.id))
    for (const [id, entry] of audio) {
      if (!keep.has(id)) { releaseMedia(entry); audio.delete(id) }
    }
    for (const { track, clip } of sounding) {
      let entry = audio.get(clip.id)
      if (!entry) {
        entry = { element: document.createElement('audio') }
        entry.element.preload = 'auto'
        listenMedia(entry)
        audio.set(clip.id, entry)
      }
      const src = host.assetUrl(clip.source.assetVersionId)
      if (entry.element.getAttribute('src') !== src) {
        entry.element.src = src
        entry.element.load()
        entry.signature = undefined
        entry.alignment = undefined
      }
      playMedia(entry, clip, track, position, clock as AudioClock, force)
    }
    const unavailable = [...activeVideos.keys()].some(video => !!video.error) || [...activeImages.keys()].some(image => image.complete && !image.naturalWidth) ||
      sounding.some(({ clip }) => clip.startMs <= position && !!audio.get(clip.id)?.element.error)
    const waiting = !unavailable && ([...activeVideos.keys()].some(video => video.readyState < 2 || video.seeking) || [...activeImages.keys()].some(image => !image.complete) ||
      sounding.some(({ clip }) => {
        const element = audio.get(clip.id)!.element
        return clip.startMs <= position && (element.readyState < 2 || element.seeking)
      }))
    if (!waiting) {
      loadingSince = undefined
      clearTimeout(loadingTimer)
      loadingTimer = undefined
    } else {
      loadingSince ??= performance.now()
      const remaining = 300 - (performance.now() - loadingSince)
      if (remaining > 0 && loadingTimer === undefined) {
        loadingTimer = setTimeout(() => { loadingTimer = undefined; tick() }, Math.ceil(remaining))
      }
    }
    const state = {
      ...(current ? { clipId: current.id } : {}),
      audioIds: sounding.filter(({ clip }) => clip.startMs <= position).map(({ clip }) => clip.id),
      loading: loadingSince !== undefined && performance.now() - loadingSince >= 300,
      unavailable,
    }
    const key = JSON.stringify(state)
    if (key !== lastState) { lastState = key; onChange(state) }
  }
  videoSounds.forEach(listenMedia)
  imageListeners.push(...images.map(image => listen(image, ['load', 'error'])))
  const unsubscribe = subscribePlaybackFrames(get().clock, clockEvent => tick(clockEvent))
  return {
    update: () => tick(),
    dispose() {
      disposed = true
      clearTimeout(loadingTimer)
      unsubscribe()
      imageListeners.forEach(unlisten => unlisten())
      for (const entry of [...videoSounds, ...audio.values()]) releaseMedia(entry)
      images.forEach(image => image.removeAttribute('src'))
      extraElements.forEach(element => element.remove())
      extraContainers.forEach(element => element.remove())
    },
  }
}
