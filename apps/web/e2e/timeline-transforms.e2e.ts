import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CanvasOp, NodeView, TimelineDoc } from '@vis/protocol'
import { createFfmpegMedia } from '../../../packages/assets/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = join(tmpdir(), 'vis-transform-preview')
const output = { width: 480, height: 360, fps: 10 }
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let timelineId: string
let imageAsset: string
let otherImageAsset: string
const missingSizes = new Set<string>()
const storedSizes = new Map<string, { width: number; height: number }>()
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!

function fixture(path: string, width: number, height: number, background: number[], boxes: { x: number; y: number; color: number[] }[]) {
  const pixels = Buffer.alloc(width * height * 3)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const box = boxes.find(box => Math.abs(x - box.x) <= 7 && Math.abs(y - box.y) <= 7)
    const color = box?.color ?? background
    color.forEach((value, channel) => { pixels[(y * width + x) * 3 + channel] = value })
  }
  writeFileSync(path, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]))
}

function decode(path: string, width: number, height: number, at?: number) {
  return execFileSync('ffmpeg', ['-v', 'error', ...(at === undefined ? [] : ['-ss', String(at)]), '-i', path,
    '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, maxBuffer: width * height * 4 })
}

function feature(pixels: Buffer, width: number, color: 'red' | 'green' | 'yellow') {
  let x = 0
  let y = 0
  let count = 0
  for (let index = 0; index < pixels.length; index += 3) {
    const r = pixels[index]!
    const g = pixels[index + 1]!
    const b = pixels[index + 2]!
    const matches = color === 'red' ? r > 150 && g < 90 && b < 90
      : color === 'green' ? g > 150 && r < 90 && b < 90 : r > 150 && g > 150 && b < 90
    if (matches) { x += index / 3 % width; y += Math.floor(index / 3 / width); count++ }
  }
  expect(count, `${color} feature remains visible`).toBeGreaterThan(10)
  return { x: x / count, y: y / count }
}

async function seek(editor: Locator, ms: number) {
  const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
  await position.fill(String(ms / 1000))
  await position.press('Enter')
  await expect.poll(() => editor.getByRole('group', { name: 'Preview', exact: true }).evaluate(element => {
    const videos = [...element.querySelectorAll('video')].filter(video => getComputedStyle(video).visibility === 'visible')
    const images = [...element.querySelectorAll('img')].filter(image => image.hasAttribute('src'))
    return videos.length > 0 && videos.every(video => video.readyState >= 2 && !video.seeking) &&
      images.every(image => image.complete && image.naturalWidth > 0 && image.currentSrc === image.src)
  })).toBe(true)
}

describe.skipIf(!ready)('Timeline transform preview and export', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-transforms-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'transforms-e2e', secretStore: createMemorySecretStore(),
      runtimes: {}, providers: [], defaults: {}, media: createFfmpegMedia() })
    spaceId = daemon.spaces.create('Transform preview acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const picture = join(dir, 'features.ppm')
    const logo = join(dir, 'overlay.ppm')
    const video = join(dir, 'features.mp4')
    const image = join(dir, 'overlay.png')
    const otherImage = join(dir, 'main.png')
    fixture(picture, 400, 240, [35, 35, 35], [{ x: 150, y: 90, color: [255, 0, 0] }, { x: 235, y: 145, color: [0, 255, 0] }])
    fixture(logo, 200, 100, [0, 0, 80], [{ x: 110, y: 45, color: [255, 255, 0] }])
    execFileSync('ffmpeg', ['-v', 'error', '-loop', '1', '-i', picture, '-t', '4', '-r', '10', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], { windowsHide: true })
    execFileSync('ffmpeg', ['-v', 'error', '-i', logo, '-frames:v', '1', '-y', image], { windowsHide: true })
    execFileSync('ffmpeg', ['-v', 'error', '-i', picture, '-frames:v', '1', '-y', otherImage], { windowsHide: true })
    otherImageAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: otherImage })).assetVersionId
    const videoAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: video })).assetVersionId
    imageAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: image })).assetVersionId
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'video', kind: 'video', title: 'Crop features', x: 40, y: 40, content: { assetVersionId: videoAsset } },
      { op: 'node.create', tempId: 'image', kind: 'image', title: 'Moving feature', x: 40, y: 280, content: { assetVersionId: imageAsset } },
      { op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Transform comparison', x: 700, y: 160 },
    ])
    timelineId = idMap.cut!
    const clip = { startMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
    // Twenty-one frames: 0 / 50 / 100% of the displayed frame span are exactly 0 / 1 / 2 s.
    const doc: TimelineDoc = { version: 1, output, tracks: [
      { id: 'main', kind: 'video', muted: false, volume: 1, clips: [{ ...clip, id: 'main-features', inMs: 1000, outMs: 3100,
        source: { nodeId: idMap.video!, assetVersionId: videoAsset }, crop: { keys: [
          { t: 1000, value: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }, ease: 'easeInOut' },
          { t: 3000, value: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, ease: 'hold' },
        ] } }] },
      { id: 'overlay', kind: 'overlay', muted: false, volume: 1, clips: [{ ...clip, id: 'moving-feature', inMs: 0, outMs: 2100,
        source: { nodeId: idMap.image!, assetVersionId: imageAsset }, crop: { keys: [
          { t: 0, value: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, ease: 'linear' },
          { t: 2000, value: { x: 0.3, y: 0.3, width: 0.4, height: 0.4 }, ease: 'hold' },
        ] }, overlay: {
          x: { keys: [{ t: 0, value: 0.8, ease: 'linear' }, { t: 2000, value: 0.7, ease: 'hold' }] },
          y: { keys: [{ t: 0, value: 0.15, ease: 'easeInOut' }, { t: 2000, value: 0.25, ease: 'hold' }] },
          width: { keys: [{ t: 0, value: 0.2, ease: 'linear' }, { t: 2000, value: 0.3, ease: 'hold' }] },
          opacity: { keys: [{ t: 0, value: 0.8, ease: 'linear' }, { t: 2000, value: 1, ease: 'hold' }] },
        } }] },
    ] }
    const node = (await nodes()).find(node => node.nodeId === timelineId)!
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    await page.routeWebSocket('**/*', socket => {
      const server = socket.connectToServer()
      const requests = new Map<number, string>()
      socket.onMessage(message => {
        const request = JSON.parse(String(message))
        if (request.method === 'asset.get') requests.set(request.id, request.params.assetVersionId)
        server.send(message)
      })
      server.onMessage(message => {
        const response = JSON.parse(String(message))
        const assetId = requests.get(response.id) ?? ''
        if (storedSizes.has(assetId) && response.result) Object.assign(response.result, storedSizes.get(assetId))
        if (missingSizes.has(assetId) && response.result) {
          delete response.result.width
          delete response.result.height
          socket.send(JSON.stringify(response))
        } else socket.send(storedSizes.has(assetId) ? JSON.stringify(response) : message)
        requests.delete(response.id)
      })
    })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.getByRole('region', { name: /^Timeline Transform comparison,/ }).getByText('2 clips · 00:02', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('matches main crop and overlay features at the first, middle and last exported frames', async () => {
    const editor = page.getByRole('dialog', { name: 'Transform comparison', exact: true })
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 30_000 })
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === timelineId)!
    const asset = main(exported).content
    if (asset.type !== 'asset') throw new Error('Expected an exported asset')
    const space = daemon.spaces.get(spaceId)!
    const version = space.assets.getVersion(space.db, asset.assetVersionId)!
    const exportedPath = space.assets.blobPath(version.blobHash)
    const frame = editor.getByRole('group', { name: 'Output frame', exact: true })
    const comparisons = []
    for (const time of [0, 1000, 2000]) {
      await seek(editor, time)
      const imagePath = join(screenshots, `preview-${time}.png`)
      await frame.screenshot({ path: imagePath, animations: 'disabled', scale: 'css' })
      const bounds = (await frame.boundingBox())!
      const width = Math.round(bounds.width)
      const height = Math.round(bounds.height)
      const previewPixels = decode(imagePath, width, height)
      const exportPixels = decode(exportedPath, width, height, time / 1000)
      for (const color of ['red', 'green', 'yellow'] as const) {
        const previewFeature = feature(previewPixels, width, color)
        const exportFeature = feature(exportPixels, width, color)
        const distance = Math.hypot(previewFeature.x - exportFeature.x, previewFeature.y - exportFeature.y)
        // Three CSS pixels cover chroma subsampling, bilinear filters and screenshot pixel rounding.
        expect(distance, `${color} at ${time}ms`).toBeLessThanOrEqual(3)
        comparisons.push({ time, color, previewFeature, exportFeature, distance })
      }
    }
    writeFileSync(join(screenshots, 'feature-comparison.json'), JSON.stringify(comparisons, null, 2))
    expect(errors).toEqual([])
  }, 60_000)

  it('updates small keyed Inspector fields during playback and seeks without changing keys', async () => {
    const editor = page.getByRole('dialog', { name: 'Transform comparison', exact: true })
    const before = main((await nodes()).find(node => node.nodeId === timelineId)!).content
    await editor.getByRole('group', { name: 'Overlay 1', exact: true }).getByRole('button', { name: /^Moving feature,/ }).click()
    const field = editor.getByRole('spinbutton', { name: 'Overlay size', exact: true })
    expect(await field.isDisabled()).toBe(false)
    await seek(editor, 0)
    expect(await field.inputValue()).toBe('20')
    await editor.getByRole('button', { name: 'Play', exact: true }).click()
    await expect.poll(async () => Number(await field.inputValue())).toBeGreaterThan(21)
    await editor.getByRole('button', { name: 'Pause', exact: true }).click()
    await seek(editor, 1000)
    expect(await field.inputValue()).toBe('25')
    expect(main((await nodes()).find(node => node.nodeId === timelineId)!).content).toEqual(before)
    expect(errors).toEqual([])
  })

  it('retains an implicit decoded frame beyond the third clip and shows a drag in small Inspector fields', async () => {
    const source = (await nodes()).find(node => node.title === 'Moving feature')!
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'other', kind: 'image', title: 'Other aspect', x: 40, y: 500, content: { assetVersionId: otherImageAsset } },
      { op: 'node.create', tempId: 'implicit', kind: 'timeline', title: 'Implicit image frame', x: 1000, y: 500 },
    ])
    const node = (await nodes()).find(node => node.nodeId === idMap.implicit)!
    const common = { inMs: 0, outMs: 1000, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
    const doc: TimelineDoc = { version: 1, tracks: [
      { id: 'images', kind: 'video', muted: false, volume: 1, clips: Array.from({ length: 4 }, (_, index) => ({
        ...common, id: `image-${index}`, startMs: index * 1000,
        source: index ? { nodeId: idMap.other!, assetVersionId: otherImageAsset } : { nodeId: source.nodeId, assetVersionId: imageAsset },
      })) },
      { id: 'picture', kind: 'overlay', muted: false, volume: 1, clips: [{ ...common, id: 'gesture', outMs: 4000, startMs: 0,
        source: { nodeId: source.nodeId, assetVersionId: imageAsset }, overlay: { x: 0.5, y: 0.5,
          width: { keys: [{ t: 0, value: 0.4, ease: 'linear' }, { t: 4000, value: 0.5, ease: 'hold' }] },
          opacity: { keys: [{ t: 0, value: 0.8, ease: 'linear' }, { t: 4000, value: 1, ease: 'hold' }] },
        } }] },
    ] }
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
    missingSizes.add(imageAsset)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.getByRole('region', { name: /^Timeline Implicit image frame,/ }).getByText('5 clips · 00:04', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Implicit image frame', exact: true })
    const frame = editor.getByRole('group', { name: 'Output frame', exact: true })
    const aspect = () => frame.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.width / rect.height })
    await expect.poll(aspect).toBeCloseTo(2, 2)
    for (const at of [1500, 2500, 3500]) {
      const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
      await position.fill(String(at / 1000))
      await position.press('Enter')
      await expect.poll(() => frame.evaluate(element => {
        const image = [...element.querySelectorAll<HTMLImageElement>('.vis-tl-picture > img')].find(image => getComputedStyle(image).visibility === 'visible')
        if (!image?.complete || !image.naturalWidth) return 0
        const rect = image.parentElement!.getBoundingClientRect()
        return rect.width / rect.height
      })).toBeCloseTo(400 / 240, 2)
      expect(await aspect()).toBeCloseTo(2, 2)
      const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
      const overlayWidth = even((0.4 + 0.1 * at / 4000) * 200)
      const overlayHeight = even(overlayWidth / 2)
      await expect.poll(() => frame.getByRole('button', { name: 'Overlay Moving feature', exact: true }).evaluate(element => {
        const rect = element.getBoundingClientRect()
        return rect.width / rect.height
      })).toBeCloseTo(overlayWidth / overlayHeight, 2)
    }
    const overlay = frame.getByRole('button', { name: 'Overlay Moving feature', exact: true })
    await overlay.click()
    const x = editor.getByRole('spinbutton', { name: 'Overlay X', exact: true })
    const width = editor.getByRole('spinbutton', { name: 'Overlay size', exact: true })
    expect(await x.inputValue()).toBe('50')
    expect(await width.inputValue()).toBe('48.8')
    expect(await width.isDisabled()).toBe(false)
    const before = main((await nodes()).find(item => item.nodeId === node.nodeId)!).content
    const box = (await overlay.boundingBox())!
    const outer = (await frame.boundingBox())!
    await page.keyboard.down('Alt')
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + outer.width * 0.1, box.y + box.height / 2, { steps: 8 })
    await expect.poll(async () => Number(await x.inputValue())).toBeCloseTo(60, 1)
    expect(await width.inputValue()).toBe('48.8')
    expect(main((await nodes()).find(item => item.nodeId === node.nodeId)!).content).toEqual(before)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => {
      const content = main((await nodes()).find(item => item.nodeId === node.nodeId)!).content
      return content.type === 'timeline' ? content.doc.tracks[1]!.clips[0]!.overlay!.x : 0
    }).toBeCloseTo(0.6, 2)
    const saved = main((await nodes()).find(item => item.nodeId === node.nodeId)!).content
    if (saved.type !== 'timeline') throw new Error('Expected a timeline document')
    expect(saved.doc.tracks[1]!.clips[0]!.overlay!.width).toEqual(doc.tracks[1]!.clips[0]!.overlay!.width)
    const field = editor.getByRole('spinbutton', { name: 'Overlay X', exact: true })
    const valueBeforeInvalid = saved.doc.tracks[1]!.clips[0]!.overlay!.x
    await field.fill('')
    await field.press('Enter')
    await editor.getByRole('status').filter({ hasText: 'Enter a valid value' }).waitFor()
    expect(await field.inputValue()).toBe(String(Number(valueBeforeInvalid) * 100))
    expect(main((await nodes()).find(item => item.nodeId === node.nodeId)!).content).toEqual(saved)
    for (const raw of ['150', '150', '100.0']) {
      await field.fill(raw)
      await field.press('Enter')
      await expect.poll(() => field.inputValue()).toBe('100')
      await expect.poll(async () => {
        const content = main((await nodes()).find(item => item.nodeId === node.nodeId)!).content
        return content.type === 'timeline' ? content.doc.tracks[1]!.clips[0]!.overlay!.x : 0
      }).toBe(1)
    }
    expect(errors).toEqual([])
  })

  it('shares decoded phone rotation with export, output settings and Inspector placement presets', async () => {
    const encoded = join(dir, 'phone-encoded.mp4')
    const phone = join(dir, 'phone.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=192x108:rate=10:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', encoded], { windowsHide: true })
    execFileSync('ffmpeg', ['-v', 'error', '-display_rotation', '90', '-i', encoded, '-c', 'copy', '-y', phone], { windowsHide: true })
    const sourceProbe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream_side_data=rotation', '-of', 'json', phone], { encoding: 'utf8', windowsHide: true }))
    expect(sourceProbe.streams[0].side_data_list[0].rotation).toBe(90)
    const phoneAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: phone })).assetVersionId
    storedSizes.set(phoneAsset, { width: 192, height: 108 })
    const source = (await nodes()).find(node => node.title === 'Moving feature')!
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'phone', kind: 'video', title: 'Phone source', x: 40, y: 700, content: { assetVersionId: phoneAsset } },
      { op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Phone rotation', x: 1000, y: 700 },
    ])
    const node = (await nodes()).find(item => item.nodeId === idMap.cut)!
    const common = { startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
    const phoneSource = { nodeId: idMap.phone!, assetVersionId: phoneAsset }
    const placement = { x: 0.5, y: 0.5, width: 0.25, opacity: 1 }
    const doc: TimelineDoc = { version: 1, tracks: [
      { id: 'main-phone', kind: 'video', volume: 1, muted: false, clips: [{ ...common, id: 'phone-main', source: phoneSource }] },
      { id: 'image-on-phone', kind: 'overlay', volume: 1, muted: false, clips: [{ ...common, id: 'phone-image', source: { nodeId: source.nodeId, assetVersionId: imageAsset }, overlay: placement }] },
      { id: 'phone-overlay', kind: 'overlay', volume: 1, muted: false, clips: [{ ...common, id: 'phone-picture', source: phoneSource, overlay: placement }] },
    ] }
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.getByRole('region', { name: /^Timeline Phone rotation,/ }).getByText('3 clips · 00:02', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Phone rotation', exact: true })
    const frame = editor.getByRole('group', { name: 'Output frame', exact: true })
    await expect.poll(() => frame.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.width / rect.height })).toBeCloseTo(108 / 192, 2)
    await expect.poll(() => editor.getByRole('button', { name: 'Output settings', exact: true }).textContent()).toContain('108×192')
    const expectCorner = async (title: string) => {
      const picture = frame.getByRole('button', { name: `Overlay ${title}`, exact: true })
      await expect.poll(() => picture.evaluate(element => {
        const outer = element.closest('[aria-label="Output frame"]')!.getBoundingClientRect()
        const inner = element.getBoundingClientRect()
        return { top: (inner.top - outer.top) / outer.height, right: (outer.right - inner.right) / outer.width }
      })).toMatchObject({ top: expect.closeTo(0.04, 2), right: expect.closeTo(0.04, 2) })
    }
    await editor.getByRole('group', { name: 'Overlay 1', exact: true }).getByRole('button', { name: /^Moving feature,/ }).click()
    await editor.getByRole('combobox', { name: 'Overlay placement', exact: true }).selectOption('topRight')
    await expectCorner('Moving feature')
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 30_000 })
    const exported = (await nodes()).find(item => item.exportOf?.timelineNodeId === node.nodeId)!
    const asset = main(exported).content
    if (asset.type !== 'asset') throw new Error('Expected an exported asset')
    const space = daemon.spaces.get(spaceId)!
    const version = space.assets.getVersion(space.db, asset.assetVersionId)!
    const dimensions = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', space.assets.blobPath(version.blobHash)], { encoding: 'utf8', windowsHide: true }).trim()
    expect(dimensions).toBe('108,192')
    await editor.getByRole('button', { name: 'Output settings', exact: true }).click()
    await editor.getByRole('combobox', { name: 'Frame rate', exact: true }).selectOption('24')
    await expect.poll(async () => {
      const content = main((await nodes()).find(item => item.nodeId === node.nodeId)!).content
      return content.type === 'timeline' ? content.doc.output : undefined
    }).toEqual({ width: 108, height: 192, fps: 24 })
    await editor.getByRole('combobox', { name: 'Output settings', exact: true }).selectOption('square')
    await editor.getByRole('group', { name: 'Overlay 2', exact: true }).getByRole('button', { name: /^Phone source,/ }).click()
    await editor.getByRole('combobox', { name: 'Overlay placement', exact: true }).selectOption('topRight')
    await expectCorner('Phone source')
    expect(errors).toEqual([])
  }, 60_000)

})
