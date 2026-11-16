import { describe, expect, it } from 'vitest'
import { overlayOpacityAt, type TimelineClip } from '@vis/protocol'
import { mediaSize, paintTransform, previewTransform } from './transform'

const source = { width: 1000, height: 500 }
const output = { width: 600, height: 600 }
const clip: TimelineClip = { id: 'clip', source: { nodeId: 'source', assetVersionId: 'asset' }, startMs: 0,
  inMs: 0, outMs: 4000, volume: 1, fadeInMs: 0, fadeOutMs: 0 }

/** Apply the emitted CSS to a source feature, without relying on the evaluator for the expectation. */
function feature(style: ReturnType<typeof previewTransform>, x: number, y: number) {
  const [tx, ty, sx, sy] = style.transform.match(/-?[\d.]+/g)!.map(Number)
  const width = parseFloat(style.box.width) / 100 * output.width
  const height = parseFloat(style.box.height) / 100 * output.height
  return { x: parseFloat(style.box.left) / 100 * output.width + width * (tx! / 100 + sx! * x / source.width),
    y: parseFloat(style.box.top) / 100 * output.height + height * (ty! / 100 + sy! * y / source.height) }
}

describe('Preview transform to CSS', () => {
  it('uses protocol opacity through fades and holds, including trims and speed, and leaves main clipping to its container', () => {
    const moving = { ...clip, startMs: 500, inMs: 1000, outMs: 5000, speed: 2, fadeInMs: 500, fadeOutMs: 700,
      overlay: { x: 0.5, y: 0.5, width: 0.4, opacity: { keys: [
        { t: 1000, value: 0.2, ease: 'hold' as const }, { t: 2000, value: 0.9, ease: 'easeInOut' as const },
        { t: 5000, value: 0.5, ease: 'linear' as const },
      ] } } }
    const container = { style: {} } as HTMLElement
    const image = { complete: true, src: 'image', currentSrc: 'image', naturalWidth: 1000, naturalHeight: 500, style: {} } as HTMLImageElement
    for (const at of [0, 500, 750, 999.8, 1000, 1500, 1800, 2000, 2400, 2500]) {
      const expected = overlayOpacityAt(moving, at)
      expect(previewTransform(moving, at, output, source).opacity).toBeCloseTo(expected, 12)
      paintTransform(container, image, moving, at, output)
      expect(Number(image.style.opacity)).toBeCloseTo(expected, 12)
    }
    const main = { style: {} } as HTMLElement
    const mainImage = { complete: true, src: 'image', currentSrc: 'image', naturalWidth: 1000, naturalHeight: 500, style: {} } as HTMLImageElement
    paintTransform(main, mainImage, clip, 100, output)
    expect(mainImage.style.clipPath).toBeUndefined()
    expect(image.style.clipPath).toContain('inset(')
  })

  it('prefers complete decoded dimensions after phone rotation and never combines size sources', () => {
    const phone = { videoWidth: 1080, videoHeight: 1920 } as HTMLVideoElement
    expect(mediaSize(phone, { width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1920 })
    expect(mediaSize({ naturalWidth: 300, naturalHeight: 200, complete: true, src: 'image', currentSrc: 'image' } as HTMLImageElement, { width: 200, height: 300 })).toEqual({ width: 300, height: 200 })
    expect(mediaSize({ videoWidth: 1080, videoHeight: 0 } as HTMLVideoElement, { height: 1920 })).toBeUndefined()
    expect(mediaSize(null, { width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 })
    expect(mediaSize(null, { width: 1920 })).toBeUndefined()
  })

  it('positions overlay controls without media, hides unknown pictures and repaints when size arrives', () => {
    const container = { style: {} } as HTMLElement
    const overlay = { ...clip, overlay: { x: 0.5, y: 0.5, width: 0.4, opacity: 0.6 }, fadeInMs: 1000 }
    expect(paintTransform(container, null, overlay, 500, output)).toBe(false)
    expect(container.style).toMatchObject({ left: '30%', top: '30%', width: '40%', height: '40%' })
    const image = { complete: true, src: 'image', currentSrc: 'image', naturalWidth: 0, naturalHeight: 0, style: { objectFit: 'contain' } } as HTMLImageElement
    expect(paintTransform(container, image, overlay, 500, output)).toBe(false)
    expect(image.style.objectFit).toBe('contain')
    expect(image.style.visibility).toBe('hidden')
    Object.assign(image, { naturalWidth: 1000, naturalHeight: 500 })
    expect(paintTransform(container, image, overlay, 500, output)).toBe(true)
    expect(container.style.height).toBe('20%')
    expect(image.style).toMatchObject({ objectFit: 'fill', opacity: '0.3', visibility: 'inherit' })
  })

  it('skips static frame writes and duplicate rounded animated samples, invalidating for size, frame and edits', () => {
    let writes = 0
    const style = () => new Proxy({} as CSSStyleDeclaration, { set(target, key, value) { writes++; Reflect.set(target, key, value); return true } })
    const container = { style: style() } as HTMLElement
    const image = { complete: true, src: 'image', currentSrc: 'image', naturalWidth: 1000, naturalHeight: 500, style: style() } as HTMLImageElement
    paintTransform(container, image, clip, 100, output)
    writes = 0
    for (let at = 101; at < 500; at++) paintTransform(container, image, clip, at, output)
    expect(writes).toBe(0)
    const moving = { ...clip, crop: { keys: [
      { t: 0, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'linear' as const },
      { t: 4000, value: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, ease: 'hold' as const },
    ] } }
    paintTransform(container, image, moving, 100.1, output)
    writes = 0
    paintTransform(container, image, moving, 100.4, output)
    expect(writes).toBe(0)
    paintTransform(container, image, moving, 101.1, output)
    expect(writes).toBeGreaterThan(0)
    writes = 0
    paintTransform(container, image, moving, 101.1, { width: 800, height: 600 })
    expect(writes).toBeGreaterThan(0)
    writes = 0
    paintTransform(container, image, moving, 101.1, output, { width: 500, height: 1000 })
    expect(writes).toBeGreaterThan(0)
  })

  it('does not let the millisecond paint cache delay an exact hold boundary', () => {
    const container = { style: {} } as HTMLElement
    const image = { complete: true, src: 'image', currentSrc: 'image', naturalWidth: 1000, naturalHeight: 500, style: {} } as HTMLImageElement
    const held = { ...clip, crop: { keys: [
      { t: 0, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'hold' as const },
      { t: 1000, value: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, ease: 'linear' as const },
    ] } }
    paintTransform(container, image, held, 999.8, output)
    expect(image.style.transform).toBe('translate(0%, 0%) scale(1, 1)')
    paintTransform(container, image, held, 1000, output)
    expect(image.style.transform).toBe('translate(-50%, -50%) scale(2, 2)')
  })

  it('fits the cropped main picture with bars when the crop and output aspects differ', () => {
    const style = previewTransform({ ...clip, crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.6 } }, 0, output, source)
    expect(style.box).toEqual({ left: '0%', top: '25%', width: '100%', height: '50%' })
    expect(feature(style, 100, 100)).toEqual({ x: expect.closeTo(0), y: expect.closeTo(150) })
    expect(feature(style, 700, 400)).toEqual({ x: expect.closeTo(600), y: expect.closeTo(450) })
    const edges = style.clipPath.match(/-?[\d.]+/g)!.map(Number)
    const expectedEdges = [20, 30, 20, 10]
    expectedEdges.forEach((edge, index) => expect(edges[index]).toBeCloseTo(edge))
  })

  it('maps overlay placement and opacity independently and sizes its box from the cropped aspect', () => {
    const style = previewTransform({ ...clip, crop: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
      overlay: { x: 0.5, y: 0.5, width: 0.4, opacity: { keys: [{ t: 0, value: 0.2, ease: 'linear' }, { t: 4000, value: 1, ease: 'hold' }] } } }, 2000, output, source)
    expect(style.box).toEqual({ left: '30%', top: '40%', width: '40%', height: '20%' })
    expect(feature(style, 200, 100)).toEqual({ x: 180, y: 240 })
    expect(feature(style, 600, 300)).toEqual({ x: 420, y: 360 })
    expect(style.opacity).toBeCloseTo(0.6)
  })

  it('samples independent overlay curves with source-time trim and exact hold boundaries', () => {
    const moving = { ...clip, inMs: 1000, outMs: 3000, speed: 2, overlay: {
      x: { keys: [{ t: 0, value: 0.25, ease: 'linear' as const }, { t: 4000, value: 0.75, ease: 'hold' as const }] },
      y: { keys: [{ t: 1000, value: 0.25, ease: 'hold' as const }, { t: 2000, value: 0.75, ease: 'linear' as const }] },
      width: { keys: [{ t: 1000, value: 0.2, ease: 'easeInOut' as const }, { t: 3000, value: 0.6, ease: 'hold' as const }] },
      opacity: 0.7,
    } }
    const before = previewTransform(moving, 499, output, source)
    const boundary = previewTransform(moving, 500, output, source)
    expect(parseFloat(before.box.top)).toBeLessThan(20)
    expect(boundary.box).toEqual({ left: '30%', top: '65%', width: '40%', height: '20%' })
    expect(boundary.opacity).toBe(0.7)
  })

  it.each(['hold', 'easeInOut'] as const)('samples %s at segment edges and holds beyond both ends', ease => {
    const moving = { ...clip, crop: { keys: [
      { t: 1000, value: { x: 0, y: 0, width: 0.5, height: 0.5 }, ease },
      { t: 3000, value: { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, ease: 'linear' as const },
    ] } }
    const at = (time: number) => feature(previewTransform(moving, time, output, source), 500, 250)
    expect(at(0)).toEqual(at(1000))
    expect(at(4000)).toEqual(at(3000))
    expect(at(1000)).toEqual({ x: 600, y: 450 })
    expect(at(3000)).toEqual({ x: 0, y: 150 })
    expect(at(1500).x).toBeCloseTo(ease === 'hold' ? 600 : 506.25)
    expect(at(2999).x).toBeCloseTo(ease === 'hold' ? 600 : 0, 2)
  })

  it('keeps keys outside a trimmed range shaping the curve and maps timeline time through speed', () => {
    const moving = { ...clip, startMs: 1000, inMs: 2000, outMs: 4000, speed: 2, crop: { keys: [
      { t: 0, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'linear' as const },
      { t: 6000, value: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, ease: 'hold' as const },
    ] } }
    const start = previewTransform(moving, 1000, output, source)
    expect(feature(start, 100, 50)).toEqual({ x: expect.closeTo(0), y: expect.closeTo(150) })
    const middle = previewTransform(moving, 1500, output, source)
    expect(feature(middle, 150, 75).x).toBeCloseTo(0)
    expect(feature(middle, 850, 425).x).toBeCloseTo(600)
    expect(moving.crop.keys).toHaveLength(2)
  })
})
