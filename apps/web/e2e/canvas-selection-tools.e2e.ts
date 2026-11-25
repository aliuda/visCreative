import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import type { CanvasOp, NodeView } from '../../../packages/protocol/src/index'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const chrome = chromePath()
const ready = existsSync(chrome) && existsSync(join(root, 'apps/web/dist/client/index.html'))
const screenshots = process.env.VIS_0052C_SCREENSHOTS ?? join(tmpdir(), 'vis-0052c')
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
const pageErrors: string[] = []
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const toolbar = () => page.getByRole('toolbar', { name: '所选节点布局', exact: true })
const titles = ['Opening study', 'Middle study', 'Closing study']
const geometry = (items: NodeView[]) => items.map(({ nodeId, x, y, w, h }) => ({ nodeId, x, y, w, h })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))

async function fitCanvas() {
  await page.getByRole('button', { name: '适应画布', exact: true }).click()
  let previous = ''
  await expect.poll(async () => {
    const current = await page.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform)
    const settled = previous === current
    previous = current
    return settled
  }, { intervals: [100] }).toBe(true)
}

async function createCards() {
  await apply(titles.map((title, index): CanvasOp => ({
    op: 'node.create', tempId: `card-${index}`, kind: 'text', title,
    x: [100, 450, 1050][index]!, y: [210, 480, 240][index]!, w: [240, 180, 300][index]!, h: 160,
    content: { text: `Study ${index + 1}` },
  })))
  await page.getByText(titles[2]!, { exact: true }).waitFor()
  await fitCanvas()
  return nodes()
}

async function selectCards(count = 3) {
  for (const title of titles.slice(0, count)) await page.getByText(title, { exact: true }).click({ modifiers: ['ControlOrMeta'] })
  await toolbar().waitFor()
}

async function undo(before: NodeView[]) {
  await page.locator('.vis-canvas-wrap').focus()
  await page.keyboard.press('ControlOrMeta+Z')
  await expect.poll(async () => geometry(await nodes())).toEqual(geometry(before))
}

async function startNearEdgeDrag(alt = false) {
  const moving = (await nodes()).find(node => node.title === 'Moving study')!
  const neighbor = (await nodes()).find(node => node.title === 'Snap neighbor')!
  const handle = page.getByText('Moving study', { exact: true })
  await handle.hover()
  const box = (await handle.boundingBox())!
  const zoom = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  if (alt) await page.keyboard.down('Alt')
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  // React Flow starts its drag origin at the activation move; activate vertically before measuring the horizontal drop.
  await page.mouse.move(start.x, start.y + 3)
  await page.locator('.react-flow__node.dragging').waitFor()
  // Four screen pixels from the left edge is inside the six-pixel snap threshold at every fitted zoom.
  await page.mouse.move(start.x + (neighbor.x - moving.x) * zoom + 4, start.y + 3, { steps: 15 })
  return { moving, neighbor, expectedRawX: Math.round(neighbor.x + 4 / zoom) }
}

describe.skipIf(!ready)('Canvas selection layout tools', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-selection-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('Selection layout studies')
    admin = await openStudiodLink({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    host = await createWebHost({ socketPath: studiod.socketPath, tokenPath: studiod.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chrome, headless: true })
    mkdirSync(screenshots, { recursive: true })
  })

  beforeEach(async () => {
    const existing = await nodes()
    if (existing.length) await apply(existing.map(node => ({ op: 'node.delete', nodeId: node.nodeId })))
    pageErrors.length = 0
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    page.setDefaultTimeout(5000)
    page.on('pageerror', error => pageErrors.push(error.message))
    await page.goto(host.url)
    await page.waitForSelector('.react-flow__pane')
    await page.evaluate(() => document.fonts.ready)
  })

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await page?.screenshot({ path: join(screenshots, 'failure.png'), animations: 'disabled' })
      expect(pageErrors).toEqual([])
    } finally { await page?.close() }
  })

  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await studiod?.stop('user_quit')
    vi.unstubAllEnvs()
    removeTempDir(dir)
  })

  it('aligns three selected cards left and restores all three with one undo', async () => {
    const before = await createCards()
    await selectCards()
    expect(await toolbar().getByRole('button').count()).toBe(9)
    await page.screenshot({ path: join(screenshots, 'selection-toolbar.png'), animations: 'disabled' })
    await toolbar().getByRole('button', { name: '左对齐', exact: true }).click()
    await expect.poll(async () => (await nodes()).map(node => node.x)).toEqual([100, 100, 100])
    await undo(before)
  })

  it('distributes unequal widths with equal horizontal gaps and undoes once', async () => {
    const before = await createCards()
    await selectCards()
    await page.screenshot({ path: join(screenshots, 'before-distribute.png'), animations: 'disabled' })
    await toolbar().getByRole('button', { name: '水平等距分布', exact: true }).click()
    await expect.poll(async () => {
      const sorted = (await nodes()).sort((a, b) => a.x - b.x)
      return [sorted[1]!.x - sorted[0]!.x - sorted[0]!.w, sorted[2]!.x - sorted[1]!.x - sorted[1]!.w]
    }).toEqual([265, 265])
    const after = (await nodes()).sort((a, b) => a.x - b.x)
    expect(after[0]!.x).toBe(100)
    expect(after[2]!.x).toBe(1050)
    await page.screenshot({ path: join(screenshots, 'after-distribute.png'), animations: 'disabled' })
    await undo(before)
  })

  it('aligns a frame-only selection with a reachable toolbar and moves each frame member once', async () => {
    await apply([
      { op: 'frame.create', tempId: 'first', title: 'Upper frame', x: 100, y: 100, w: 600, h: 400 },
      { op: 'frame.create', tempId: 'last', title: 'Lower frame', x: 1000, y: 700, w: 600, h: 400 },
      { op: 'node.create', tempId: 'a', kind: 'text', title: 'Upper member', x: 200, y: 220, w: 200, h: 120 },
      { op: 'node.create', tempId: 'b', kind: 'text', title: 'Lower member', x: 1100, y: 820, w: 200, h: 120 },
    ])
    await page.getByText('Lower frame', { exact: true }).waitFor()
    await fitCanvas()
    const before = await nodes()
    for (const title of ['Upper frame', 'Lower frame']) await page.getByText(title, { exact: true }).click({ modifiers: ['ControlOrMeta'] })
    await toolbar().waitFor()
    expect(await toolbar().getByRole('button', { name: '原地整理所选节点', exact: true }).isDisabled()).toBe(true)
    await toolbar().getByRole('button', { name: '左对齐', exact: true }).click()
    await expect.poll(async () => (await nodes()).filter(node => node.kind === 'frame').map(node => node.x)).toEqual([100, 100])
    expect((await nodes()).filter(node => node.kind !== 'frame').map(node => node.x)).toEqual([200, 200])
    await undo(before)
  })

  it('tidies the selection into a grid without a dialog and undoes once', async () => {
    const before = await createCards()
    await selectCards()
    await toolbar().getByRole('button', { name: '原地整理所选节点', exact: true }).click()
    await expect.poll(async () => {
      const current = await nodes()
      return [new Set(current.map(node => node.x)).size, new Set(current.map(node => node.y)).size]
    }).toEqual([2, 2])
    expect(await page.locator('dialog[open]').count()).toBe(0)
    expect((await nodes()).some(node => node.kind === 'frame')).toBe(false)
    await undo(before)
  })

  it('explains why distribution needs three cards and hides tools for menus and dialogs', async () => {
    await createCards()
    await selectCards(2)
    const distribute = toolbar().getByRole('button', { name: '水平等距分布', exact: true })
    expect(await distribute.isDisabled()).toBe(true)
    expect(await distribute.getAttribute('title')).toBe('请至少选中三个节点以等距分布')
    await page.getByText(titles[0]!, { exact: true }).click({ button: 'right' })
    await page.getByRole('menu', { name: '画布右键菜单', exact: true }).waitFor()
    expect(await toolbar().isVisible()).toBe(false)
    await page.keyboard.press('Escape')
    await toolbar().waitFor()
    await page.locator('.vis-canvas-wrap').focus()
    await page.keyboard.press('?')
    await page.getByRole('dialog').waitFor()
    expect(await toolbar().isVisible()).toBe(false)
    await page.keyboard.press('Escape')
    await toolbar().waitFor()
  })

  it('keeps the toolbar reachable and clear of the selected group after panning under fixed controls', async () => {
    await createCards()
    await selectCards()
    const canvas = (await page.locator('.react-flow').boundingBox())!
    await page.mouse.move(canvas.x + 60, canvas.y + 320)
    await page.mouse.down()
    await page.mouse.move(canvas.x + 60, canvas.y + 70, { steps: 12 })
    await page.mouse.up()
    await expect.poll(async () => {
      const bar = (await toolbar().boundingBox())!
      const selected = await page.locator('.react-flow__node.selected').evaluateAll(elements => elements.map(element => {
        const bounds = element.getBoundingClientRect()
        return { left: bounds.left, top: bounds.top - 20, right: bounds.right, bottom: bounds.bottom }
      }))
      const withinCanvas = bar.x >= canvas.x && bar.y >= canvas.y && bar.x + bar.width <= canvas.x + canvas.width && bar.y + bar.height <= canvas.y + canvas.height
      const clearsNodes = selected.every(node => bar.x + bar.width <= node.left || bar.x >= node.right || bar.y + bar.height <= node.top || bar.y >= node.bottom)
      return withinCanvas && clearsNodes
    }).toBe(true)
    expect(await toolbar().getByRole('button', { name: '左对齐', exact: true }).isEnabled()).toBe(true)
  })

  it('snaps a multi-card drag by group bounds, hides the toolbar and commits one undo step', async () => {
    await apply([
      { op: 'node.create', tempId: 'neighbor', kind: 'text', title: 'Snap neighbor', x: 100, y: 80, w: 200, h: 100 },
      { op: 'node.create', tempId: 'first', kind: 'text', title: 'Group first', x: 620, y: 400, w: 200, h: 120 },
      { op: 'node.create', tempId: 'last', kind: 'text', title: 'Group last', x: 920, y: 600, w: 200, h: 120 },
    ])
    await page.getByText('Group last', { exact: true }).waitFor()
    await fitCanvas()
    const before = await nodes()
    for (const title of ['Group first', 'Group last']) await page.getByText(title, { exact: true }).click({ modifiers: ['ControlOrMeta'] })
    await toolbar().waitFor()
    const handle = page.getByText('Group last', { exact: true })
    await handle.hover()
    const box = (await handle.boundingBox())!
    const zoom = await page.locator('.react-flow__viewport').evaluate(el => new DOMMatrixReadOnly(getComputedStyle(el).transform).a)
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x, start.y + 3)
    await page.locator('.react-flow__node.dragging').first().waitFor()
    await page.mouse.move(start.x - 520 * zoom + 4, start.y + 3, { steps: 15 })
    await page.locator('.vis-snap-guides i').waitFor()
    expect(await toolbar().count()).toBe(0)
    await page.mouse.up()
    await expect.poll(async () => (await nodes()).filter(node => node.title?.startsWith('Group')).sort((a, b) => a.x - b.x).map(node => node.x)).toEqual([100, 400])
    await undo(before)
  })

  it.each([false, true])('snaps near a neighbor edge unless Alt is held: %s', async alt => {
    await apply([
      { op: 'node.create', tempId: 'neighbor', kind: 'text', title: 'Snap neighbor', x: 100, y: 100, w: 240, h: 160 },
      { op: 'node.create', tempId: 'moving', kind: 'text', title: 'Moving study', x: 620, y: 500, w: 240, h: 160 },
    ])
    await page.getByText('Moving study', { exact: true }).waitFor()
    await fitCanvas()
    const before = await nodes()
    const { moving, neighbor, expectedRawX } = await startNearEdgeDrag(alt)
    if (alt) expect(await page.locator('.vis-snap-guides i').count()).toBe(0)
    else {
      await page.locator('.vis-snap-guides i').waitFor()
      await page.screenshot({ path: join(screenshots, 'snap-guide.png'), animations: 'disabled' })
    }
    await page.mouse.up()
    if (alt) await page.keyboard.up('Alt')
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === moving.nodeId)!.x).toBe(alt ? expectedRawX : neighbor.x)
    expect(await page.locator('.vis-snap-guides').count()).toBe(0)
    await undo(before)
  })

  it('suspends and resumes snapping immediately when Alt changes during a drag', async () => {
    await apply([
      { op: 'node.create', tempId: 'neighbor', kind: 'text', title: 'Snap neighbor', x: 100, y: 100, w: 240, h: 160 },
      { op: 'node.create', tempId: 'moving', kind: 'text', title: 'Moving study', x: 620, y: 500, w: 240, h: 160 },
    ])
    await page.getByText('Moving study', { exact: true }).waitFor()
    await fitCanvas()
    const { moving, neighbor } = await startNearEdgeDrag()
    await page.locator('.vis-snap-guides i').waitFor()
    await page.keyboard.down('Alt')
    await expect.poll(() => page.locator('.vis-snap-guides i').count()).toBe(0)
    await page.keyboard.up('Alt')
    await page.locator('.vis-snap-guides i').waitFor()
    await page.mouse.up()
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === moving.nodeId)!.x).toBe(neighbor.x)
  })
})
