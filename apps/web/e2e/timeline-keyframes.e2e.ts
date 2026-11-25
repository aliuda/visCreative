import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { clipTransformAt, evaluateAnimated, isAnimated, sourceTimeAt, type CanvasOp, type NodeView, type TimelineDoc, type TimelineClip } from '@vis/protocol'
import { createFfmpegMedia } from '../../../packages/assets/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const ready = existsSync(chromePath()) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = '/tmp/vis-step-c-review4'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let spaceId: string
let timelineId: string
let videoSource: TimelineClip['source']
let imageSource: TimelineClip['source']
const errors: string[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const main = (node: NodeView) => node.slots.find(slot => slot.slotKey === 'main')!
async function document() {
  const content = main((await nodes()).find(node => node.nodeId === timelineId)!).content
  if (content.type !== 'timeline') throw new Error('Expected a timeline document')
  return content.doc
}
async function seek(editor: Locator, ms: number) {
  const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
  await position.fill(String(ms / 1000))
  await position.press('Enter')
}
async function number(editor: Locator, label: string, value: string) {
  const field = editor.getByRole('spinbutton', { name: label, exact: true })
  await field.fill(value)
  await field.press('Enter')
}
async function undoRedo(editor: Locator, before: TimelineDoc, after: TimelineDoc) {
  await editor.getByRole('button', { name: 'Export', exact: true }).focus()
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(document).toEqual(before)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect.poll(document).toEqual(after)
}

async function openReviewTimeline(doc: TimelineDoc, title: string) {
  await page.getByRole('button', { name: 'Close editor', exact: true }).click()
  const { idMap } = await apply([{ op: 'node.create', tempId: 'review', kind: 'timeline', title, x: 1000, y: 700 }])
  timelineId = idMap.review!
  const node = (await nodes()).find(node => node.nodeId === timelineId)!
  await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  await page.getByRole('region', { name: new RegExp('^Timeline ' + title + ',') }).getByText(/clips ·/).click()
  await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
  const editor = page.getByRole('dialog', { name: title, exact: true })
  await editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Reframe shot,/ }).click()
  return editor
}
function reviewDocument(crop?: TimelineClip['crop']): TimelineDoc {
  return { version: 1, output: { width: 240, height: 400, fps: 10 }, tracks: [
    { id: 'main', kind: 'video', volume: 1, muted: false, clips: [{ id: 'review-shot', source: videoSource, startMs: 0, inMs: 1000, outMs: 5000, speed: 2, volume: 1, fadeInMs: 0, fadeOutMs: 0, ...(crop ? { crop } : {}) }] },
  ] }
}

describe.skipIf(!ready)('Minimal transform key editor', () => {
  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-keyframes-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'keyframes-e2e', secretStore: createMemorySecretStore(), runtimes: {}, providers: [], defaults: {}, media: createFfmpegMedia() })
    spaceId = daemon.spaces.create('Key editor acceptance').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    const video = join(dir, 'source.mp4')
    const image = join(dir, 'logo.png')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:size=400x240:rate=10:duration=6', '-vf', 'drawgrid=w=40:h=24:t=1:color=0x404040,drawbox=x=370:y=180:w=16:h=16:color=blue:t=fill,drawbox=x=150:y=90:w=16:h=16:color=red:t=fill,drawbox=x=230:y=140:w=16:h=16:color=lime:t=fill', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], { windowsHide: true })
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=yellow:size=100x50', '-frames:v', '1', '-y', image], { windowsHide: true })
    const videoAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: video })).assetVersionId
    const imageAsset = (await admin.call('asset.import', { requestId: crypto.randomUUID(), path: image })).assetVersionId
    const { idMap } = await apply([
      { op: 'node.create', tempId: 'video', kind: 'video', title: 'Reframe shot', x: 40, y: 40, content: { assetVersionId: videoAsset } },
      { op: 'node.create', tempId: 'image', kind: 'image', title: 'Motion logo', x: 40, y: 280, content: { assetVersionId: imageAsset } },
      { op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Key editor', x: 700, y: 160 },
    ])
    timelineId = idMap.cut!
    videoSource = { nodeId: idMap.video!, assetVersionId: videoAsset }
    imageSource = { nodeId: idMap.image!, assetVersionId: imageAsset }
    const common = { startMs: 0, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
    const doc: TimelineDoc = { version: 1, output: { width: 400, height: 240, fps: 10 }, tracks: [
      { id: 'main', kind: 'video', volume: 1, muted: false, clips: [{ ...common, id: 'shot', source: { nodeId: idMap.video!, assetVersionId: videoAsset }, inMs: 1000, outMs: 5000, speed: 2 }] },
      { id: 'overlay', kind: 'overlay', volume: 1, muted: false, clips: [{ ...common, id: 'logo', source: { nodeId: idMap.image!, assetVersionId: imageAsset }, inMs: 0, outMs: 2000, overlay: { x: 0.8, y: 0.15, width: 0.2, opacity: 1 } }] },
    ] }
    const node = (await nodes()).find(node => node.nodeId === timelineId)!
    await apply([{ op: 'timeline.set', slotId: main(node).slotId, expectedRevision: main(node).revision, doc }])
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(host.url, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
    await page.getByRole('region', { name: /^Timeline Key editor,/ }).getByText('2 clips · 00:02', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(screenshots, 'failure-key-editor.png'), animations: 'disabled' })
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('adds, edits, retimes and eases crop keys with one undo step per action', async () => {
    const editor = page.getByRole('dialog', { name: 'Key editor', exact: true })
    await editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Reframe shot,/ }).click()
    await seek(editor, 0)
    const before = await document()
    await editor.getByRole('button', { name: 'Crop keyframe: Static (hollow)', exact: true }).click()
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).toEqual({ keys: [{ t: 1000, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'linear' }, { t: 5000, value: { x: 0, y: 0, width: 1, height: 1 }, ease: 'linear' }] })
    await undoRedo(editor, before, await document())
    await seek(editor, 1000)
    await editor.getByRole('button', { name: 'Crop keyframe: Animated, no key here (half filled)', exact: true }).waitFor()
    const beforeEdit = await document()
    await number(editor, 'Crop width', '70')
    await expect.poll(async () => {
      const crop = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(crop) ? crop.keys.find(key => key.t === 3000)?.value.width : 0
    }).toBe(0.7)
    await undoRedo(editor, beforeEdit, await document())
    const beforeEase = await document()
    await editor.getByRole('combobox', { name: 'Crop key ease', exact: true }).selectOption('easeInOut')
    await expect.poll(async () => {
      const crop = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(crop) ? crop.keys.find(key => key.t === 3000)?.ease : ''
    }).toBe('easeInOut')
    await undoRedo(editor, beforeEase, await document())
    const key = editor.getByRole('button', { name: 'Key at 00:01.00: Crop', exact: true })
    const beforeMove = await document()
    await key.hover()
    const box = (await key.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 - 30, box.y + box.height / 2, { steps: 8 })
    expect(await document()).toEqual(beforeMove)
    await page.mouse.up()
    await expect.poll(async () => {
      const crop = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(crop) ? crop.keys.map(key => key.t) : []
    }).toEqual([1000, 2000, 5000])
    await expect.poll(() => editor.getByRole('button', { name: 'Key at 00:00.05: Crop', exact: true }).evaluate(element => element === element.ownerDocument.activeElement)).toBe(true)
    await undoRedo(editor, beforeMove, await document())
    await editor.getByRole('button', { name: 'Crop previous key', exact: true }).click()
    await editor.getByRole('button', { name: 'Crop keyframe: Key here (filled)', exact: true }).waitFor()
    await editor.getByRole('button', { name: 'Crop next key', exact: true }).click()
    const beforeDelete = await document()
    const movedKey = editor.getByRole('button', { name: 'Key at 00:00.05: Crop', exact: true })
    await movedKey.click()
    await movedKey.press('Delete')
    await expect.poll(async () => {
      const crop = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(crop) ? crop.keys.length : 0
    }).toBe(2)
    expect((await document()).tracks[0]!.clips).toHaveLength(1)
    await undoRedo(editor, beforeDelete, await document())
    // Restore the edited key to exercise crop editing on that source frame.
    await editor.getByRole('button', { name: 'Export', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(document).toEqual(beforeDelete)
    await seek(editor, 500)
    await page.screenshot({ path: join(screenshots, 'transform-section.png'), animations: 'disabled' })
    expect(errors).toEqual([])
  })

  it('refits all crop keys on aspect changes, edits with handles and keyboard, and preserves overlay keys on drag', async () => {
    const editor = page.getByRole('dialog', { name: 'Key editor', exact: true })
    const beforeAspect = await document()
    await editor.getByRole('combobox', { name: 'Aspect lock', exact: true }).selectOption('1:1')
    await expect.poll(async () => {
      const crop = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(crop) ? crop.keys.map(key => key.value.width / key.value.height) : []
    }).toEqual([0.6, 0.6, 0.6])
    await undoRedo(editor, beforeAspect, await document())
    const beforeCrop = await document()
    await editor.getByRole('button', { name: 'Edit crop', exact: true }).click()
    const mode = editor.getByRole('group', { name: 'Crop mode', exact: true })
    const handle = mode.getByRole('button', { name: 'Crop: Bottom right corner', exact: true })
    await handle.hover()
    const box = (await handle.boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x - 35, box.y - 35, { steps: 8 })
    expect(await document()).toEqual(beforeCrop)
    await page.mouse.up()
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).not.toEqual(beforeCrop.tracks[0]!.clips[0]!.crop)
    await undoRedo(editor, beforeCrop, await document())
    const beforeNudge = await document()
    await mode.getByRole('button', { name: 'Crop: Move', exact: true }).focus()
    await page.keyboard.press('Shift+ArrowRight')
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).not.toEqual(beforeNudge.tracks[0]!.clips[0]!.crop)
    await undoRedo(editor, beforeNudge, await document())
    await page.screenshot({ path: join(screenshots, 'crop-mode.png'), animations: 'disabled' })
    await mode.getByRole('button', { name: 'Done crop', exact: true }).click()
    await expect.poll(() => mode.count()).toBe(0)
    await editor.getByRole('button', { name: 'Edit crop', exact: true }).click()
    await page.keyboard.press('Escape')
    await expect.poll(() => mode.count()).toBe(0)
    await editor.getByRole('group', { name: 'Overlay 1', exact: true }).getByRole('button', { name: /^Motion logo,/ }).click()
    await seek(editor, 0)
    await editor.getByRole('button', { name: 'Overlay X keyframe: Static (hollow)', exact: true }).click()
    await seek(editor, 1000)
    const beforeDrag = await document()
    const overlay = editor.getByRole('button', { name: 'Overlay Motion logo', exact: true })
    await overlay.click()
    expect(await document()).toEqual(beforeDrag)
    await overlay.hover()
    const overlayBox = (await overlay.boundingBox())!
    const frameBox = (await editor.getByRole('group', { name: 'Output frame', exact: true }).boundingBox())!
    await page.keyboard.down('Alt')
    await page.mouse.move(overlayBox.x + overlayBox.width / 2, overlayBox.y + overlayBox.height / 2)
    await page.mouse.down()
    await page.mouse.move(overlayBox.x + overlayBox.width / 2 - frameBox.width * 0.1, overlayBox.y + overlayBox.height / 2, { steps: 8 })
    expect(await document()).toEqual(beforeDrag)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => (await document()).tracks[1]!.clips[0]!.overlay!.x).toEqual({ keys: [{ t: 0, value: 0.8, ease: 'linear' }, { t: 1000, value: 0.7, ease: 'linear' }, { t: 2000, value: 0.8, ease: 'linear' }] })
    await undoRedo(editor, beforeDrag, await document())
    await number(editor, 'Opacity', '60')
    await editor.getByRole('button', { name: 'Opacity keyframe: Static (hollow)', exact: true }).click()
    const beforeReset = await document()
    await editor.getByRole('button', { name: 'Reset transform', exact: true }).click()
    await expect.poll(async () => (await document()).tracks[1]!.clips[0]!.overlay).toEqual({ x: 0.7, y: 0.15, width: 0.2, opacity: 0.6 })
    await undoRedo(editor, beforeReset, await document())
    await editor.getByRole('button', { name: 'Export', exact: true }).focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(document).toEqual(beforeReset)
    expect(errors).toEqual([])
  })

  it('previews and exports the authored keys at the same sampled source frames', async () => {
    const editor = page.getByRole('dialog', { name: 'Key editor', exact: true })
    const doc = await document()
    const revision = main((await nodes()).find(node => node.nodeId === timelineId)!).revision
    await editor.getByRole('button', { name: 'Export', exact: true }).click()
    await editor.getByText('Exported', { exact: true }).waitFor({ timeout: 30_000 })
    const exported = (await nodes()).find(node => node.exportOf?.timelineNodeId === timelineId)!
    expect(exported.exportOf?.timelineRevision).toBe(revision)
    const content = main(exported).content
    if (content.type !== 'asset') throw new Error('Expected an exported asset')
    const space = daemon.spaces.get(spaceId)!
    const version = space.assets.getVersion(space.db, content.assetVersionId)!
    const path = space.assets.blobPath(version.blobHash)
    const frame = editor.getByRole('group', { name: 'Output frame', exact: true })
    const centroid = (pixels: Buffer, width: number) => {
      let x = 0; let y = 0; let count = 0
      for (let i = 0; i < pixels.length; i += 3) if (pixels[i]! > 150 && pixels[i + 1]! < 90 && pixels[i + 2]! < 90) { x += i / 3 % width; y += Math.floor(i / 3 / width); count++ }
      expect(count).toBeGreaterThan(10)
      return { x: x / count, y: y / count }
    }
    for (const time of [0, 500, 1000, 1900]) {
      await seek(editor, time)
      const clip = doc.tracks[0]!.clips[0]!
      const transform = clipTransformAt(clip, sourceTimeAt(clip, time), doc.output!, { width: 400, height: 240 })
      await expect.poll(() => frame.evaluate(element => {
        const media = [...element.querySelectorAll<HTMLVideoElement>('.vis-tl-picture > video')].find(video => getComputedStyle(video).visibility === 'visible')
        return media && media.readyState >= 2 && !media.seeking ? Number.parseFloat(media.parentElement!.style.width) : 0
      })).toBeCloseTo(transform.rect.width / doc.output!.width * 100, 2)
      const overlay = doc.tracks[1]!.clips[0]!
      const x = evaluateAnimated(overlay.overlay!.x, time)
      await expect.poll(() => editor.getByRole('button', { name: 'Overlay Motion logo', exact: true }).evaluate(element => Number.parseFloat(element.parentElement!.style.left))).toBeCloseTo((x - 0.1) * 100, 1)
      const imagePath = join(screenshots, `authored-preview-${time}.png`)
      await frame.screenshot({ path: imagePath, animations: 'disabled', scale: 'css' })
      const box = (await frame.boundingBox())!
      const width = Math.round(box.width); const height = Math.round(box.height)
      const decode = (file: string, at?: number) => execFileSync('ffmpeg', ['-v', 'error', ...(at === undefined ? [] : ['-ss', String(at / 1000)]), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true, maxBuffer: width * height * 4 })
      const preview = centroid(decode(imagePath), width)
      const rendered = centroid(decode(path, time), width)
      expect(Math.hypot(preview.x - rendered.x, preview.y - rendered.y)).toBeLessThanOrEqual(3)
    }
    expect(errors).toEqual([])
  }, 60_000)

  it('preserves existing crop geometry until relocked and opens an absent crop at the full document frame', async () => {
    const crop = { x: 0.1, y: 0.2, width: 0.7, height: 0.6 }
    const editor = await openReviewTimeline(reviewDocument(crop), 'Preserve crop')
    expect(await editor.getByRole('combobox', { name: 'Aspect lock', exact: true }).inputValue()).toBe('free')
    await number(editor, 'Crop X', '20')
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).toEqual({ ...crop, x: 0.2 })
    await editor.getByRole('button', { name: 'Edit crop', exact: true }).click()
    const mode = editor.getByRole('group', { name: 'Crop mode', exact: true })
    await mode.getByRole('button', { name: 'Crop: Move', exact: true }).press('Shift+ArrowLeft')
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).toEqual({ ...crop, x: 0.19 })
    await mode.getByRole('button', { name: 'Done crop', exact: true }).click()
    const fullEditor = await openReviewTimeline(reviewDocument(), 'Full crop')
    expect(await fullEditor.getByRole('combobox', { name: 'Aspect lock', exact: true }).inputValue()).toBe('output')
    const before = await document()
    await fullEditor.getByRole('button', { name: 'Edit crop', exact: true }).click()
    const fullMode = fullEditor.getByRole('group', { name: 'Crop mode', exact: true })
    const source = fullMode.getByRole('group', { name: 'Full source frame', exact: true })
    const move = fullMode.getByRole('button', { name: 'Crop: Move', exact: true })
    // The crop frame receives its initial size asynchronously from ResizeObserver.
    await expect.poll(async () => {
      const frame = await source.boundingBox()
      const bounds = await move.boundingBox()
      if (!frame?.width || !frame.height || !bounds) return Infinity
      return Math.max(Math.abs(bounds.width - frame.width), Math.abs(bounds.height - frame.height))
    }).toBeCloseTo(0, 1)
    await move.press('ArrowRight')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
    expect(await document()).toEqual(before)
    expect(await fullEditor.getByRole('spinbutton', { name: 'Crop width', exact: true }).inputValue()).toBe('100')
    expect(await fullEditor.getByRole('spinbutton', { name: 'Crop height', exact: true }).inputValue()).toBe('100')
    await fullMode.getByRole('button', { name: 'Done crop', exact: true }).click()
  })

  it('updates crop limits on seeks, hides trimmed-out keys, keeps endpoint diamonds inside the clip and preserves visible outside content', async () => {
    const rect = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
    const crop = { keys: Array.from({ length: 32 }, (_, i) => ({ t: i === 31 ? 5000 : i * 100, value: rect, ease: 'linear' as const })) }
    const editor = await openReviewTimeline(reviewDocument(crop), 'Crop limits')
    const clip = editor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Reframe shot,/ })
    await clip.click()
    await seek(editor, 0)
    expect(await editor.getByRole('button', { name: /^Key at / }).count()).toBe(22)
    expect(await editor.getByRole('button', { name: 'Key at 00:00.00 (50 ms): Crop', exact: true }).count()).toBe(1)
    const first = editor.getByRole('button', { name: 'Key at 00:00.00: Crop', exact: true })
    const last = editor.getByRole('button', { name: 'Key at 00:02.00: Crop', exact: true })
    const frame = (await clip.boundingBox())!
    const firstBox = (await first.boundingBox())!
    const lastBox = (await last.boundingBox())!
    expect(firstBox.x).toBeGreaterThanOrEqual(frame.x)
    expect(lastBox.x + lastBox.width).toBeLessThanOrEqual(frame.x + frame.width + 0.1)
    const label = (await clip.getByText('Reframe shot', { exact: true }).boundingBox())!
    expect(label.y + label.height).toBeLessThanOrEqual(firstBox.y)
    expect(await last.getAttribute('title')).toBe('Key at 00:02.00: Crop')
    await page.screenshot({ path: join(screenshots, 'transform-section-limits.png'), animations: 'disabled' })
    await editor.getByRole('button', { name: 'Edit crop', exact: true }).click()
    const mode = editor.getByRole('group', { name: 'Crop mode', exact: true })
    const handle = mode.getByRole('button', { name: 'Crop: Move', exact: true })
    expect(await handle.isDisabled()).toBe(false)
    await seek(editor, 25)
    await expect.poll(() => handle.isDisabled()).toBe(true)
    const reason = 'Maximum 32 keys per property; remove a key first'
    expect(await handle.getAttribute('title')).toBe(reason)
    await mode.getByRole('status').filter({ hasText: reason }).waitFor()
    const before = await document()
    await handle.dispatchEvent('keydown', { key: 'ArrowRight' })
    expect(await document()).toEqual(before)
    await seek(editor, 50)
    await expect.poll(() => handle.isDisabled()).toBe(false)
    await expect.poll(() => mode.getByRole('status').textContent()).toBe('')
    await handle.press('ArrowRight')
    await expect.poll(async () => {
      const value = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(value) ? value.keys.find(key => key.t === 1100)?.value.x : 0
    }).toBe(0.101)
    const source = mode.getByRole('group', { name: 'Full source frame', exact: true })
    const path = join(screenshots, 'dimmed-source.png')
    await source.screenshot({ path, animations: 'disabled', scale: 'css' })
    const pixels = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-frames:v', '1', '-vf', 'scale=400:240', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true })
    const index = (188 * 400 + 378) * 3
    expect(pixels[index + 2]! - pixels[index]!).toBeGreaterThan(30)
    expect(pixels[index + 2]! - pixels[index + 1]!).toBeGreaterThan(30)
    await page.screenshot({ path: join(screenshots, 'crop-mode.png'), animations: 'disabled' })
    await mode.getByRole('button', { name: 'Done crop', exact: true }).click()
  })

  it('writes only the moved overlay axis when the other animated axis is at its key limit', async () => {
    const doc = reviewDocument()
    const y = { keys: Array.from({ length: 32 }, (_, i) => ({ t: i * 100, value: 0.15, ease: 'linear' as const })) }
    doc.tracks.push({ id: 'overlay', kind: 'overlay', volume: 1, muted: false, clips: [{ id: 'axis-logo', source: imageSource, startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0,
      overlay: { x: { keys: [{ t: 0, value: 0.8, ease: 'linear' }, { t: 2000, value: 0.8, ease: 'linear' }] }, y, width: 0.2, opacity: 1 } }] })
    const editor = await openReviewTimeline(doc, 'Independent axes')
    const timelineClip = editor.getByRole('group', { name: 'Overlay 1', exact: true }).getByRole('button', { name: /^Motion logo,/ })
    const glyph = (await timelineClip.getByRole('img', { name: 'Has transform keys', exact: true }).boundingBox())!
    // The label box includes gradient padding; only its foreground content must clear the motion glyph.
    const labelTop = await timelineClip.getByText('Motion logo', { exact: true }).evaluate(element => {
      const content = element.ownerDocument.createRange()
      content.selectNodeContents(element)
      return content.getBoundingClientRect().top
    })
    expect(glyph.y + glyph.height).toBeLessThanOrEqual(labelTop)
    await seek(editor, 1050)
    const overlay = editor.getByRole('button', { name: 'Overlay Motion logo', exact: true })
    await overlay.focus()
    await overlay.press('ArrowLeft')
    await expect.poll(async () => {
      const value = (await document()).tracks[1]!.clips[0]!.overlay!.x
      return isAnimated(value) ? value.keys.find(key => key.t === 1050)?.value : 0
    }).toBe(0.795)
    expect((await document()).tracks[1]!.clips[0]!.overlay!.y).toEqual(y)
    const before = await document()
    const bounds = (await overlay.boundingBox())!
    const frame = (await editor.getByRole('group', { name: 'Output frame', exact: true }).boundingBox())!
    await page.keyboard.down('Alt')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 - frame.width * 0.1, bounds.y + bounds.height / 2, { steps: 8 })
    expect(await document()).toEqual(before)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => {
      const value = (await document()).tracks[1]!.clips[0]!.overlay!.x
      return isAnimated(value) ? value.keys.find(key => key.t === 1050)?.value : 0
    }).toBe(0.695)
    expect((await document()).tracks[1]!.clips[0]!.overlay!.y).toEqual(y)
    expect(errors).toEqual([])
  })

  it('retains the default Output lock through crop commits and leaves labels low when every key is trimmed out', async () => {
    const editor = await openReviewTimeline(reviewDocument(), 'Stable aspect lock')
    const lock = editor.getByRole('combobox', { name: 'Aspect lock', exact: true })
    expect(await lock.inputValue()).toBe('output')
    await editor.getByRole('button', { name: 'Edit crop', exact: true }).click()
    const mode = editor.getByRole('group', { name: 'Crop mode', exact: true })
    const edge = mode.getByRole('button', { name: 'Crop: Right edge', exact: true })
    await edge.press('Shift+ArrowLeft')
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).not.toBeUndefined()
    expect(await lock.inputValue()).toBe('output')
    const first = await document()
    await edge.press('Shift+ArrowLeft')
    await expect.poll(document).not.toEqual(first)
    const crop = (await document()).tracks[0]!.clips[0]!.crop!
    expect(isAnimated(crop)).toBe(false)
    if (!isAnimated(crop)) expect(crop.width / crop.height).toBeCloseTo(0.36, 2)
    expect(await lock.inputValue()).toBe('output')
    await mode.getByRole('button', { name: 'Done crop', exact: true }).click()
    await number(editor, 'Crop width', '20')
    expect(await lock.inputValue()).toBe('output')
    await number(editor, 'Crop height', '50')
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).toMatchObject({ width: 0.18, height: 0.5 })
    const outside = { keys: [0, 500].map(t => ({ t, value: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, ease: 'linear' as const })) }
    const hiddenEditor = await openReviewTimeline(reviewDocument(outside), 'Hidden crop keys')
    expect(await hiddenEditor.getByRole('button', { name: /^Key at / }).count()).toBe(0)
    const clip = hiddenEditor.getByRole('group', { name: 'Video', exact: true }).getByRole('button', { name: /^Reframe shot,/ })
    const bounds = (await clip.boundingBox())!
    const label = (await clip.getByText('Reframe shot', { exact: true }).boundingBox())!
    expect(label.y + label.height).toBeGreaterThan(bounds.y + bounds.height - 2)
  })

  it('enables placement presets per changed property after seeking between capped keys', async () => {
    const doc = reviewDocument()
    const y = { keys: Array.from({ length: 32 }, (_, i) => ({ t: i * 100, value: 0.5, ease: 'linear' as const })) }
    doc.tracks.push({ id: 'preset-overlay', kind: 'overlay', volume: 1, muted: false, clips: [{ id: 'preset-logo', source: imageSource, startMs: 0, inMs: 0, outMs: 2000, volume: 1, fadeInMs: 0, fadeOutMs: 0,
      overlay: { x: { keys: [{ t: 0, value: 0.8, ease: 'linear' }, { t: 2000, value: 0.8, ease: 'linear' }] }, y, width: 0.2, opacity: 1 } }] })
    const editor = await openReviewTimeline(doc, 'Changed preset axes')
    await editor.getByRole('group', { name: 'Overlay 1', exact: true }).getByRole('button', { name: /^Motion logo,/ }).click()
    const presets = editor.getByRole('combobox', { name: 'Overlay placement', exact: true })
    await seek(editor, 1050)
    await expect.poll(() => presets.getByRole('option', { name: 'Top right', exact: true }).isDisabled()).toBe(true)
    expect(await presets.getByRole('option', { name: 'Centre', exact: true }).isDisabled()).toBe(false)
    const before = await document()
    await presets.selectOption('centre')
    await expect.poll(async () => {
      const value = (await document()).tracks[1]!.clips[0]!.overlay!.x
      return isAnimated(value) ? value.keys.find(key => key.t === 1050)?.value : 0
    }).toBe(0.5)
    const after = await document()
    expect(after.tracks[1]!.clips[0]!.overlay!.y).toEqual(y)
    await undoRedo(editor, before, after)
    await presets.selectOption('fullWidth')
    await expect.poll(async () => (await document()).tracks[1]!.clips[0]!.overlay!.width).toBe(1)
    expect((await document()).tracks[1]!.clips[0]!.overlay!.y).toEqual(y)
    expect(errors).toEqual([])
  })

  it('derives an external crop aspect and preserves that framing on the next resize', async () => {
    const editor = await openReviewTimeline(reviewDocument(), 'External framing')
    const lock = editor.getByRole('combobox', { name: 'Aspect lock', exact: true })
    expect(await lock.inputValue()).toBe('output')
    const node = (await nodes()).find(node => node.nodeId === timelineId)!
    const slot = main(node)
    const crop = { x: 0.1, y: 0.1, width: 0.64, height: 0.8 }
    await apply([{ op: 'timeline.set', slotId: slot.slotId, expectedRevision: slot.revision, doc: reviewDocument(crop) }])
    await expect.poll(() => lock.inputValue()).toBe('4:3')
    await number(editor, 'Crop width', '60')
    await expect.poll(async () => (await document()).tracks[0]!.clips[0]!.crop).toMatchObject({ width: 0.6, height: 0.75 })
    await lock.selectOption('1:1')
    await expect.poll(() => lock.inputValue()).toBe('1:1')
    await expect.poll(async () => {
      const explicit = (await document()).tracks[0]!.clips[0]!.crop!
      return isAnimated(explicit) ? NaN : explicit.width / explicit.height * 400 / 240
    }).toBeCloseTo(1, 2)
  })

})
