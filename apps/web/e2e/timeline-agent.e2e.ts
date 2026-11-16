import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isAnimated, type NodeView, type TimelineDoc } from '@vis/protocol'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { deepseekRuntime } from '../../../services/studiod/src/deepseek'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const cli = join(root, 'apps/cli/dist/vis.mjs')
const ffmpeg = process.platform === 'darwin' ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg'
const hasFfmpeg = (command: string) => spawnSync(command, ['-version'], { windowsHide: true, stdio: 'ignore' }).status === 0
const ready = hasFfmpeg(ffmpeg) && existsSync(chromePath()) && existsSync(cli) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = process.platform === 'win32' ? 'C:/tmp/vis-step-d-agents' : '/tmp/vis-step-d-agents'
const rid = () => crypto.randomUUID()

async function seek(editor: Locator, ms: number) {
  const position = editor.getByRole('textbox', { name: 'Playback position', exact: true })
  await position.fill(String(ms / 1000))
  await position.press('Enter')
}

async function captureFailure(page: Page | undefined, admin: StudiodLink | undefined, agentKind: string) {
  if (page && !page.isClosed()) await page.screenshot({ path: join(screenshots, `${agentKind}-failure.png`), animations: 'disabled' })
  if (admin && !admin.closed) writeFileSync(join(screenshots, `${agentKind}-failure.json`), JSON.stringify(await admin.call('work.list', {}), null, 2))
}

it('preserves a setup error when browser and admin resources are not yet available', async () => {
  const setupError = new Error('Fixture setup failed before resources were created')
  await expect((async () => {
    try { throw setupError }
    finally { await captureFailure(undefined, undefined, 'setup') }
  })()).rejects.toBe(setupError)
  expect(hasFfmpeg(join(tmpdir(), 'missing-vis-ffmpeg', 'ffmpeg'))).toBe(false)
})

// The identical fixture runs through the real app-server and ACP adapters, vis MCP and gateway.
describe.skipIf(!ready).each(['codex', 'deepseek'] as const)('Timeline transforms via fake %s', agentKind => {
  let dir: string
  let daemon: Studiod
  let host: WebHost
  let admin: StudiodLink
  let browser: Browser
  let page: Page
  const errors: string[] = []
  const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes

  beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), `vis-timeline-${agentKind}-`))
    const dataDir = join(dir, 'data')
    const options = { dataDir, socketPath: studiodEndpoint(dataDir), visMcp: { command: process.execPath, args: [cli, 'mcp'] } }
    const fake = join(root, 'apps/web/e2e/fake-timeline-agent.mjs')
    daemon = await startStudiod({ dataDir, studiodVersion: 'timeline-agent-e2e', providers: [], defaults: {}, secretStore: createMemorySecretStore(),
      runtimes: { codex: codexRuntime({ ...options, codexPath: fake }), deepseek: deepseekRuntime({ ...options, dshPath: fake }) } })
    const { spaceId } = daemon.spaces.create({ requestId: rid(), name: 'Transform agent acceptance', rootPath: join(dir, 'project') })
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') await captureFailure(page, admin, agentKind)
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    if (dir) removeTempDir(dir)
  })

  it('writes keyed crops and overlay placement, displays diamonds and sampled pictures, and receives validation guidance', async () => {
    const video = join(dir, 'quadrants.mp4')
    const image = join(dir, 'green.png')
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=blue:size=320x180:rate=10:duration=6,drawbox=x=0:y=0:w=160:h=90:color=red:t=fill', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-y', video], { windowsHide: true })
    execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=lime:size=80x40', '-frames:v', '1', '-y', image], { windowsHide: true })
    const videoAsset = (await admin.call('asset.import', { requestId: rid(), path: video })).assetVersionId
    const imageAsset = (await admin.call('asset.import', { requestId: rid(), path: image })).assetVersionId
    const { idMap } = await admin.call('canvas.apply', { requestId: rid(), ops: [
      { op: 'node.create', tempId: 'source', kind: 'video', title: 'Transform source', content: { assetVersionId: videoAsset } },
      { op: 'node.create', tempId: 'overlay', kind: 'image', title: 'Transform overlay', content: { assetVersionId: imageAsset } },
    ] })
    const created = await admin.call('canvas.apply', { requestId: rid(), ops: [{ op: 'node.create', tempId: 'cut', kind: 'timeline', title: 'Agent cut', content: { timelineFrom: [idMap.source] } }] })
    const timelineId = created.idMap.cut
    const { item } = await admin.call('work.create', { requestId: rid(), title: `${agentKind} transforms`, chat: { agentKind } })
    const sessionId = item.sessions[0]!.sessionId
    await admin.call('session.sendMessage', { requestId: rid(), sessionId, text: 'Write the clip transform acceptance fixture.', refs: [] })
    const transcript = () => admin.call('session.getTranscript', { sessionId })
    await expect.poll(async () => (await transcript()).items.some(entry => entry.kind === 'assistant_text' && String(entry.payload.text).startsWith('Clip transforms applied.')), { timeout: 20_000 }).toBe(true)
    const entries = (await transcript()).items
    const failures = entries.filter(entry => entry.kind === 'tool_result' && entry.payload.isError)
    expect(failures).toHaveLength(2)
    expect(failures.map(entry => entry.payload.text).join('\n')).toContain('crop keys must keep one aspect ratio')
    expect(failures.map(entry => entry.payload.text).join('\n')).toContain('Too big: expected array to have <=32 items')
    for (const failure of failures) expect(failure.payload.text).toContain('See guide \\"timeline\\"')
    const timeline = (await nodes()).find(node => node.nodeId === timelineId)!
    const slot = timeline.slots.find(slot => slot.slotKey === 'main')!
    if (slot.content.type !== 'timeline') throw new Error('Expected timeline content')
    const doc: TimelineDoc = slot.content.doc
    expect(slot.revision).toBe(2)
    const crop = doc.tracks[0]!.clips[0]!.crop!
    expect(isAnimated(crop) && crop.keys.map(key => key.t)).toEqual([1000, 5000])
    for (const value of Object.values(doc.tracks[1]!.clips[0]!.overlay!)) expect(isAnimated(value)).toBe(true)

    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    const card = page.getByRole('region', { name: /^Timeline Agent cut,/ })
    await card.getByText('2 clips · 00:02', { exact: true }).click()
    await page.getByRole('button', { name: 'Open timeline', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Agent cut', exact: true })
    await editor.getByRole('button', { name: /^Transform source, / }).click()
    expect(await editor.getByRole('button', { name: /^Key at .*: Crop$/ }).count()).toBe(2)
    await editor.getByRole('button', { name: /^Transform overlay, / }).click()
    expect(await editor.getByRole('button', { name: /^Key at .*Crop.*Overlay X.*Overlay Y.*Overlay size.*Opacity/ }).count()).toBe(2)
    const preview = editor.getByRole('group', { name: 'Output frame', exact: true })
    const overlay = preview.getByRole('button', { name: 'Overlay Transform overlay', exact: true })
    const sample = () => overlay.evaluate(element => {
      const frame = element.closest('[aria-label="Output frame"]')!.getBoundingClientRect()
      const rect = element.getBoundingClientRect()
      return { x: (rect.x - frame.x + rect.width / 2) / frame.width, y: (rect.y - frame.y + rect.height / 2) / frame.height,
        width: rect.width / frame.width, opacity: Number(getComputedStyle(element.parentElement!.querySelector('img')!).opacity) }
    })
    for (const [ms, expected] of [[0, { x: 0.25, y: 0.25, width: 0.2, opacity: 1 }], [1500, { x: 0.625, y: 113 / 180, width: 0.35, opacity: 0.625 }]] as const) {
      await seek(editor, ms)
      // Percentage geometry is quantized to browser subpixels; keep the tolerance below half a CSS pixel.
      for (const property of ['x', 'y', 'width', 'opacity'] as const) await expect.poll(async () => (await sample())[property]).toBeCloseTo(expected[property], 3)
      await expect.poll(() => preview.evaluate((element, ms) => {
        const video = [...element.querySelectorAll('video')].find(video => getComputedStyle(video).visibility === 'visible')
        return !!video && video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime * 1000 - (1000 + ms * 2)) < 2
      }, ms)).toBe(true)
      const screenshot = join(screenshots, `${agentKind}-${ms}.png`)
      await preview.screenshot({ path: screenshot, animations: 'disabled' })
      const pixel = execFileSync(ffmpeg, ['-v', 'error', '-i', screenshot, '-vf', 'scale=320:180,crop=1:1:112:117', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'], { windowsHide: true })
      if (ms === 0) { expect(pixel[0]).toBeGreaterThan(180); expect(pixel[2]).toBeLessThan(60) }
      else { expect(pixel[2]).toBeGreaterThan(180); expect(pixel[0]).toBeLessThan(60) }
    }
    expect(errors).toEqual([])
  }, 60_000)
})
