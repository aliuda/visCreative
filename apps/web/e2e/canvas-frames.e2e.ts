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
const screenshots = process.env.VIS_0052B_SCREENSHOTS ?? join(tmpdir(), 'vis-0052b')
let dir: string
let studiod: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
const pageErrors: string[] = []
const nodes = async () => (await admin.call('canvas.get')).nodes as NodeView[]
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const menu = () => page.getByRole('menu', { name: '画布右键菜单', exact: true })
const editor = () => page.getByRole('textbox', { name: '框标题', exact: true })
const frames = async () => (await nodes()).filter(node => node.kind === 'frame')
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
  await apply(['Opening card', 'Middle card', 'Closing card'].map((title, index): CanvasOp => ({
    op: 'node.create', tempId: `card-${index}`, kind: 'text', title,
    x: 100 + index * 380, y: 200, w: 320, h: 200, content: { text: `Content ${index + 1}` },
  })))
  await page.getByText('Closing card', { exact: true }).waitFor()
  await fitCanvas()
  return (await nodes()).filter(node => node.kind !== 'frame')
}

async function selectCards(titles = ['Opening card', 'Middle card', 'Closing card']) {
  for (const title of titles) await page.getByText(title, { exact: true }).click({ modifiers: ['ControlOrMeta'] })
  await expect.poll(() => page.locator('.react-flow__node.selected').count()).toBe(titles.length)
}

async function undo() {
  await page.locator('.vis-canvas-wrap').focus()
  await page.keyboard.press('ControlOrMeta+Z')
}

async function context(title: string) {
  await page.getByText(title, { exact: true }).click({ button: 'right' })
  await menu().waitFor()
}

describe.skipIf(!ready)('Frames the author manages', () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'vis-frames-e2e-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    studiod = await startStudiod({
      dataDir: dir, studiodVersion: 'e2e', runtimes: {}, secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })],
      defaults: { image: { provider: 'mock' }, video: { provider: 'mock' }, audio: { provider: 'mock' } },
    })
    const { spaceId } = studiod.spaces.create('Author frames')
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

  it('frames three selected cards, selects the title text, saves a name and undoes rename separately from creation', async () => {
    const cards = await createCards()
    const before = geometry(cards)
    await selectCards()
    await page.keyboard.press('ControlOrMeta+G')
    await editor().waitFor()
    expect(await editor().inputValue()).toBe('框')
    expect(await editor().evaluate(el => {
      const input = el as HTMLInputElement
      return document.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length
    })).toBe(true)
    await expect.poll(async () => (await frames()).length).toBe(1)
    const frame = (await frames())[0]!
    await expect.poll(async () => (await nodes()).filter(node => cards.some(card => card.nodeId === node.nodeId)).every(node => node.frameId === frame.nodeId)).toBe(true)
    expect(await page.locator('.vis-flow-frame.selected').count()).toBe(1)
    await page.screenshot({ path: join(screenshots, 'title-editor.png'), animations: 'disabled' })
    await editor().fill('Sequence studies')
    await editor().press('Enter')
    await page.getByText('Sequence studies', { exact: true }).waitFor()
    expect(geometry((await nodes()).filter(node => node.kind !== 'frame'))).toEqual(before)
    await undo()
    await page.locator('.vis-frame-header').getByText('框', { exact: true }).waitFor()
    await undo()
    await expect.poll(async () => (await frames()).length).toBe(0)
    expect(geometry(await nodes())).toEqual(before)
    expect((await nodes()).every(node => !node.frameId)).toBe(true)
  })

  it('undoes frame creation in one step after cancelling its initial title edit', async () => {
    await createCards()
    await selectCards()
    await page.keyboard.press('ControlOrMeta+G')
    await editor().press('Escape')
    await undo()
    await expect.poll(async () => (await frames()).length).toBe(0)
    expect((await nodes()).length).toBe(3)
  })

  it('renames through double click and the context menu, cancels Escape or blank titles, and saves on blur', async () => {
    await apply([{ op: 'frame.create', tempId: 'frame', title: 'Original frame', x: 100, y: 100, w: 600, h: 400 }])
    await page.getByText('Original frame', { exact: true }).waitFor()
    await fitCanvas()
    await page.getByText('Original frame', { exact: true }).dblclick()
    await editor().fill('Cancelled title')
    await editor().press('Escape')
    expect((await frames())[0]!.frame!.title).toBe('Original frame')
    await context('Original frame')
    await menu().getByRole('menuitem', { name: '重命名框', exact: true }).click()
    await editor().fill('   ')
    await editor().press('Enter')
    await page.getByText('Original frame', { exact: true }).waitFor()
    await page.getByText('Original frame', { exact: true }).dblclick()
    expect(await editor().getAttribute('maxlength')).toBe('60')
    await editor().fill('  Renamed on blur  ')
    await page.getByRole('button', { name: '适应画布', exact: true }).click()
    await expect.poll(async () => (await frames())[0]!.frame!.title).toBe('Renamed on blur')
    await page.getByText('Renamed on blur', { exact: true }).waitFor()
  })

  it('recolors through eight named swatches with current state and arrow-key navigation', async () => {
    await createCards()
    await selectCards()
    await page.keyboard.press('ControlOrMeta+G')
    await editor().fill('Color studies')
    await editor().press('Enter')
    await context('Color studies')
    await menu().getByRole('menuitem', { name: '颜色', exact: true }).click()
    const colors = page.getByRole('menu', { name: '颜色', exact: true })
    expect(await colors.getByRole('button').count()).toBe(8)
    const gray = colors.getByRole('button', { name: '灰色', exact: true })
    expect(await gray.getAttribute('aria-pressed')).toBe('true')
    await expect.poll(() => gray.evaluate(el => document.activeElement === el)).toBe(true)
    await gray.press('ArrowRight')
    const blue = colors.getByRole('button', { name: '蓝色', exact: true })
    expect(await blue.evaluate(el => document.activeElement === el)).toBe(true)
    await page.screenshot({ path: join(screenshots, 'color-menu.png'), animations: 'disabled' })
    await blue.press('Enter')
    await expect.poll(async () => (await frames())[0]!.frame!.color).toBe('blue')
    await context('Color studies')
    await menu().getByRole('menuitem', { name: '颜色', exact: true }).click()
    expect(await page.getByRole('button', { name: '蓝色', exact: true }).getAttribute('aria-pressed')).toBe('true')
  })

  it('fits a large frame to direct members without moving them and disables an exact fit', async () => {
    await apply([
      { op: 'frame.create', tempId: 'frame', title: 'Room to fit', x: 0, y: 0, w: 1500, h: 850 },
      { op: 'node.create', tempId: 'a', kind: 'text', title: 'Fit opening', x: 200, y: 220, w: 320, h: 200 },
      { op: 'node.create', tempId: 'b', kind: 'text', title: 'Fit closing', x: 650, y: 220, w: 320, h: 200 },
    ])
    await page.getByText('Fit closing', { exact: true }).waitFor()
    await fitCanvas()
    const before = (await frames())[0]!
    const members = (await nodes()).filter(node => node.frameId === before.nodeId)
    await page.screenshot({ path: join(screenshots, 'before-fit.png'), animations: 'disabled' })
    await context('Room to fit')
    await menu().getByRole('menuitem', { name: '适应内容', exact: true }).click()
    await expect.poll(async () => geometry(await frames())).toEqual([{ nodeId: before.nodeId, x: 176, y: 164, w: 818, h: 280 }])
    expect(geometry((await nodes()).filter(node => node.kind !== 'frame'))).toEqual(geometry(members))
    expect((await nodes()).filter(node => node.frameId === before.nodeId).length).toBe(2)
    await page.screenshot({ path: join(screenshots, 'after-fit.png'), animations: 'disabled' })
    await context('Room to fit')
    expect(await menu().getByRole('menuitem', { name: '适应内容', exact: true }).isDisabled()).toBe(true)
    await page.keyboard.press('Escape')
    await undo()
    await expect.poll(async () => geometry(await frames())).toEqual(geometry([before]))
  })

  it.each([false, true])('refuses cross-frame selections including open canvas: %s', async openCanvas => {
    await apply([
      { op: 'frame.create', tempId: 'a', title: 'First frame', x: 0, y: 0, w: 600, h: 500 },
      ...(!openCanvas ? [{ op: 'frame.create' as const, tempId: 'b', title: 'Second frame', x: 700, y: 0, w: 600, h: 500 }] : []),
      { op: 'node.create', tempId: 'one', kind: 'text', title: 'First member', x: 100, y: 150 },
      { op: 'node.create', tempId: 'two', kind: 'text', title: 'Second member', x: 800, y: 150 },
    ])
    await page.getByText('Second member', { exact: true }).waitFor()
    await fitCanvas()
    const before = await nodes()
    await selectCards(['First member', 'Second member'])
    await page.keyboard.press('ControlOrMeta+G')
    await page.getByRole('alert').getByText('请选择同一个框内的节点，或全部位于画布空白区域的节点，再创建新框。', { exact: true }).waitFor()
    expect(await nodes()).toEqual(before)
    expect(await editor().count()).toBe(0)
  })

  it('creates a nested frame from the context menu and undoes ancestor growth in the same step', async () => {
    await apply([
      { op: 'frame.create', tempId: 'outer', title: 'Outer frame', x: 0, y: 0, w: 500, h: 400 },
      { op: 'node.create', tempId: 'one', kind: 'text', title: 'Nested member', x: 30, y: 60, w: 320, h: 200 },
    ])
    await page.getByText('Nested member', { exact: true }).waitFor()
    await fitCanvas()
    const outer = (await frames())[0]!
    const member = (await nodes()).find(node => node.kind !== 'frame')!
    await context('Nested member')
    await menu().getByRole('menuitem', { name: /将所选节点放入新框/ }).click()
    await editor().press('Escape')
    await expect.poll(async () => (await frames()).length).toBe(2)
    const current = await frames()
    const inner = current.find(node => node.nodeId !== outer.nodeId)!
    expect(inner.frameId).toBe(outer.nodeId)
    expect(current.find(node => node.nodeId === outer.nodeId)!.y).toBeLessThan(outer.y)
    expect((await nodes()).find(node => node.nodeId === member.nodeId)!.frameId).toBe(inner.nodeId)
    await undo()
    await expect.poll(async () => geometry(await frames())).toEqual(geometry([outer]))
    expect((await nodes()).find(node => node.nodeId === member.nodeId)!.frameId).toBe(outer.nodeId)
  })

  it('does not consume the framing shortcut in inputs, textareas or inherited contenteditable elements', async () => {
    await createCards()
    await selectCards()
    for (const kind of ['input', 'textarea', 'editable', 'inherited-editable', 'plaintext-only']) {
      const prevented = await page.locator('.vis-canvas-wrap').evaluate((canvas, kind) => {
        const control = document.createElement(kind === 'input' || kind === 'textarea' ? kind : 'div')
        let target = control
        if (kind === 'editable' || kind === 'inherited-editable') control.setAttribute('contenteditable', '')
        if (kind === 'plaintext-only') control.setAttribute('contenteditable', 'plaintext-only')
        if (kind === 'inherited-editable') {
          target = document.createElement('span')
          control.append(target)
        }
        canvas.append(control)
        control.focus()
        const prevented = !target.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true, cancelable: true }))
        control.remove()
        return prevented
      }, kind)
      expect(prevented).toBe(false)
    }
    expect(await frames()).toEqual([])
  })

  it('offers Delete instead of fit on an empty frame and ignores frame-only selections', async () => {
    await apply([{ op: 'frame.create', tempId: 'frame', title: 'Empty frame', x: 100, y: 100, w: 600, h: 400 }])
    await page.getByText('Empty frame', { exact: true }).waitFor()
    await fitCanvas()
    await page.getByText('Empty frame', { exact: true }).dblclick()
    expect(await editor().evaluate(el => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true, cancelable: true })))).toBe(false)
    await editor().press('Escape')
    expect((await frames()).length).toBe(1)
    await page.locator('.vis-canvas-wrap').focus()
    expect(await page.locator('.vis-canvas-wrap').evaluate(el => !el.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', ctrlKey: true, bubbles: true, cancelable: true })))).toBe(true)
    expect((await frames()).length).toBe(1)
    await context('Empty frame')
    expect(await menu().getByRole('menuitem', { name: '适应内容', exact: true }).count()).toBe(0)
    expect(await menu().getByRole('menuitem', { name: /删除/ }).count()).toBe(1)
  })
})
