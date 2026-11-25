import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CanvasOp, NodeView, OrganizeColumns, OrganizeMode, OrganizeProposal } from '@vis/protocol'
import { organizePlanDigest, planOrganize } from '../../../packages/canvas/layout/src/index'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const shots = '/tmp/vis-0052d2'
const titles = { uncategorized: 'Uncategorized', untitledScript: 'Untitled script' }
const undoKey = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let sessionId: string
let ids: string[]
const errors: string[] = []
const requests: { method: string; params?: any }[] = []
const nodes = async (): Promise<NodeView[]> => (await admin.call('canvas.get', {})).nodes
const proposals = async (): Promise<OrganizeProposal[]> => (await admin.call('canvas.organize.proposals', { status: 'all' })).proposals
const apply = (ops: CanvasOp[]) => admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops })
const layout = (items: NodeView[]) => items.map(({ nodeId, x, y, w, h, frameId }) => ({ nodeId, x, y, w, h, frameId })).sort((a, b) => a.nodeId.localeCompare(b.nodeId))
const bar = () => page.getByRole('status', { name: 'Canvas organize suggestion', exact: true })
const dialog = () => page.getByRole('dialog', { name: 'Organize canvas', exact: true })
const card = (reason: string) => page.getByRole('article', { name: 'Organize suggestion', exact: true }).filter({ hasText: reason })
const screenshot = (name: string) => page.screenshot({ path: join(shots, name), animations: 'disabled' })

async function propose(reason: string, mode: OrganizeMode = 'category', columns: OrganizeColumns = 'auto', targetSession = sessionId) {
  await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId: targetSession,
    text: `canvas-organize-proposal ${JSON.stringify({ reason, mode, columns, nodeIds: ids })}`, refs: [] })
  await expect.poll(async () => (await admin.call('session.getTranscript', { sessionId: targetSession })).items.some(item =>
    item.kind === 'assistant_text' && item.payload.text === `Completed organize proposal: ${reason}`), { timeout: 15_000 }).toBe(true)
  await expect.poll(async () => (await admin.call('session.list')).sessions.find(session => session.sessionId === targetSession)?.activeTurnId).toBeNull()
  return (await proposals()).find(proposal => proposal.reason === reason)!
}
async function fitCanvas() {
  await page.getByRole('button', { name: 'Fit canvas', exact: true }).click()
  let previous = ''
  await expect.poll(async () => {
    const current = await page.locator('.react-flow__viewport').evaluate(el => getComputedStyle(el).transform)
    const settled = current === previous
    previous = current
    return settled
  }, { intervals: [100] }).toBe(true)
}

describe('Author review of organize proposals', () => {
  beforeAll(async () => {
    expect(existsSync(join(root, 'apps/web/dist/client/index.html'))).toBe(true)
    mkdirSync(shots, { recursive: true })
    dir = mkdtempSync(join(tmpdir(), 'vis-organize-proposals-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({ dataDir: dir, studiodVersion: 'organize-proposals-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'),
        visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) } })
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    const spaceId = daemon.spaces.create('Organize suggestions').spaceId
    await admin.call('events.subscribe', { spaceId })
    const created = await apply([
      { op: 'node.create', tempId: 'a', kind: 'image', title: 'Opening', x: 100, y: 100, w: 320, h: 180 },
      { op: 'node.create', tempId: 'b', kind: 'image', title: 'Arrival', x: 650, y: 460, w: 320, h: 180 },
      { op: 'node.create', tempId: 'c', kind: 'image', title: 'Return', x: 1100, y: 180, w: 320, h: 180 },
    ])
    ids = ['a', 'b', 'c'].map(id => created.idMap[id]!)
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Layout partner', agentKind: 'codex' })).sessionId
    errors.length = 0
    requests.length = 0
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framesent', frame => {
      try {
        const request = JSON.parse(String(frame.payload))
        if (request.method) requests.push(request)
      } catch { /* Only JSON-RPC requests matter here. */ }
    }))
    const url = new URL(host.url)
    url.searchParams.set('space', spaceId)
    await page.goto(url.href, { waitUntil: 'domcontentloaded' })
    await page.getByRole('listitem', { name: /^Layout partner,/ }).click()
    await page.evaluate(() => document.fonts.ready)
    await fitCanvas()
  })
  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail') await screenshot(`failure-${task.name.replaceAll(/[^a-z0-9]+/gi, '-')}.png`)
      expect(errors).toEqual([])
    } finally {
      // Root work items retain execution slots after their turns; release each isolated fixture before the next project.
      for (const item of (await admin.call('work.list', { scope: 'space' })).items) {
        if (item.status === 'in_progress') await admin.call('work.recall', { requestId: crypto.randomUUID(), workItemId: item.workItemId })
      }
      await page?.close()
    }
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    if (dir) removeTempDir(dir)
  })

  it('shows the count and plain-text reason, previews without resolving, applies and undoes in one step', async () => {
    const reason = 'Keep <b>these results</b> together.'
    const before = layout(await nodes())
    const proposal = await propose(reason)
    await bar().getByText(`Layout partner suggests organizing ${proposal.changed} nodes by category: ${reason}`, { exact: true }).waitFor()
    await card(reason).getByText('Pending', { exact: true }).waitFor()
    expect(await bar().locator('b').count()).toBe(0)
    expect(await bar().getByText(reason, { exact: false }).getAttribute('title')).toBe(reason)
    await screenshot('bar-and-pending-card.png')
    await bar().getByRole('button', { name: 'Preview', exact: true }).click()
    await dialog().getByText(reason, { exact: true }).waitFor()
    expect(await dialog().getByRole('radio', { name: 'By category', exact: true }).isChecked()).toBe(true)
    expect(requests.filter(request => request.method === 'canvas.organize.resolve')).toEqual([])
    expect(layout(await nodes())).toEqual(before)
    expect((await proposals())[0]!.status).toBe('pending')
    await screenshot('locked-dialog.png')
    await dialog().getByRole('button', { name: 'Organize', exact: true }).click()
    await dialog().waitFor({ state: 'hidden' })
    await expect.poll(() => bar().count()).toBe(0)
    await card(reason).getByText('Applied', { exact: true }).waitFor()
    const organized = await nodes()
    expect(organized.filter(node => node.kind === 'frame').map(node => node.frame?.title)).toEqual(['Uncategorized'])
    expect(layout(organized)).not.toEqual(before)
    expect(requests.filter(request => request.method === 'canvas.organize.resolve')).toMatchObject([{ params: {
      action: 'apply', proposalId: proposal.proposalId, removeEmptyFrames: true, titles, description: 'Organize canvas', planDigest: expect.any(String),
    } }])
    await screenshot('transcript-applied.png')
    await page.keyboard.press(undoKey)
    await expect.poll(async () => layout(await nodes())).toEqual(before)
    await card(reason).getByText('Applied', { exact: true }).waitFor()
  })

  it('replans after an author drag and applies the current preview instead of becoming stale', async () => {
    const reason = 'Tidy this selection in place.'
    const proposal = await propose(reason, 'inPlace', 2)
    await bar().waitFor()
    const oldPlan = planOrganize({ nodes: await nodes(), mode: 'inPlace', nodeIds: ids, columns: 2, removeEmptyFrames: true, titles })
    const target = page.locator(`.react-flow__node[data-id="${ids[0]}"] .vis-node-label`)
    const bounds = (await target.boundingBox())!
    const before = (await nodes()).find(node => node.nodeId === ids[0])!
    await page.mouse.move(bounds.x + 20, bounds.y + 8)
    await page.mouse.down()
    await page.keyboard.down('Alt')
    await page.mouse.move(bounds.x - 60, bounds.y - 35, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(async () => (await nodes()).find(node => node.nodeId === ids[0])!.x).not.toBe(before.x)
    const current = await nodes()
    const plan = planOrganize({ nodes: current, mode: 'inPlace', nodeIds: ids, columns: 2, removeEmptyFrames: true, titles })
    expect(organizePlanDigest(plan)).not.toBe(organizePlanDigest(oldPlan))
    await bar().getByRole('button', { name: 'Preview', exact: true }).click()
    await dialog().getByText(reason, { exact: true }).waitFor()
    const preview = await dialog().getByRole('img', { name: 'Frames and nodes after organization', exact: true }).locator('.vis-preview-node').evaluateAll(elements =>
      elements.map(el => ({ x: Number(el.getAttribute('x')), y: Number(el.getAttribute('y')) })))
    expect(preview).toEqual(current.filter(node => ids.includes(node.nodeId)).map(node => {
      const op = plan.ops.find(op => op.op === 'node.layout' && op.nodeId === node.nodeId) as Extract<CanvasOp, { op: 'node.layout' }> | undefined
      return { x: op?.x ?? node.x, y: op?.y ?? node.y }
    }))
    await dialog().getByRole('button', { name: 'Organize', exact: true }).click()
    await expect.poll(async () => (await proposals()).find(value => value.proposalId === proposal.proposalId)?.status).toBe('applied')
    expect(requests.find(request => request.method === 'canvas.organize.resolve')?.params.planDigest).toBe(organizePlanDigest(plan))
    for (const op of plan.ops) if (op.op === 'node.layout') expect((await nodes()).find(node => node.nodeId === op.nodeId)).toMatchObject({ x: op.x, y: op.y })
  })

  it('dismisses without moving anything and keeps the current dismissed status after reloading', async () => {
    const reason = 'Group the current results.'
    const before = layout(await nodes())
    await propose(reason)
    await bar().getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect.poll(() => bar().count()).toBe(0)
    await card(reason).getByText('Dismissed', { exact: true }).waitFor()
    expect(layout(await nodes())).toEqual(before)
    await screenshot('transcript-dismissed.png')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('listitem', { name: /^Layout partner,/ }).click()
    await card(reason).getByText('Dismissed', { exact: true }).waitFor()
    expect(await card(reason).getByRole('button', { name: 'Preview', exact: true }).count()).toBe(0)
  })

  it('turns a changed column count into the author organize and dismisses only after success', async () => {
    const reason = 'Try a compact group.'
    const proposal = await propose(reason)
    await bar().getByRole('button', { name: 'Preview', exact: true }).click()
    await dialog().getByText(reason, { exact: true }).waitFor()
    await dialog().getByRole('combobox', { name: 'Columns', exact: true }).selectOption('1')
    await expect.poll(() => dialog().getByText(reason, { exact: true }).count()).toBe(0)
    expect((await proposals())[0]!.status).toBe('pending')
    await dialog().getByRole('checkbox', { name: 'Remove frames left empty after tidy', exact: true }).uncheck()
    await dialog().getByRole('button', { name: 'Organize', exact: true }).click()
    await expect.poll(async () => (await proposals()).find(value => value.proposalId === proposal.proposalId)?.status).toBe('dismissed')
    const writes = requests.filter(request => ['canvas.organize', 'canvas.organize.resolve'].includes(request.method))
    expect(writes).toMatchObject([
      { method: 'canvas.organize', params: { mode: 'category', nodeIds: ids, columns: 1, removeEmptyFrames: false } },
      { method: 'canvas.organize.resolve', params: { proposalId: proposal.proposalId, action: 'dismiss' } },
    ])
    const content = (await nodes()).filter(node => node.kind === 'image')
    expect(new Set(content.map(node => node.x)).size).toBe(1)
    await card(reason).getByText('Dismissed', { exact: true }).waitFor()
  })

  it('supersedes the older card and opens the new proposal from the transcript while on the board', async () => {
    const first = 'Group by category first.'
    const second = 'Keep the selection in place instead.'
    await propose(first)
    await card(first).getByText('Pending', { exact: true }).waitFor()
    await propose(second, 'inPlace', 2)
    await card(first).getByText('Superseded', { exact: true }).waitFor()
    await bar().getByText(second, { exact: false }).waitFor()
    expect(await bar().getByText(first, { exact: false }).count()).toBe(0)
    expect(await bar().getByRole('button', { name: '+1 more', exact: true }).count()).toBe(0)
    await page.getByRole('tab', { name: 'Board', exact: true }).click()
    await card(second).getByRole('button', { name: 'Preview', exact: true }).click()
    await dialog().getByText(second, { exact: true }).waitFor()
    expect(await page.getByRole('tab', { name: 'Canvas', exact: true }).getAttribute('aria-selected')).toBe('true')
    expect(await dialog().getByRole('radio', { name: 'In place', exact: true }).isChecked()).toBe(true)
    expect(await dialog().getByRole('combobox', { name: 'Columns', exact: true }).inputValue()).toBe('2')
    expect(requests.filter(request => request.method === 'canvas.organize.resolve')).toEqual([])
  })

  it('cycles proposals from different sessions and keeps pending data when the project reopens', async () => {
    const otherSession = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Second partner', agentKind: 'codex' })).sessionId
    await propose('First direction.')
    await propose('Second direction.', 'category', 2, otherSession)
    await bar().getByText('Second partner suggests organizing', { exact: false }).waitFor()
    await bar().getByRole('button', { name: '+1 more', exact: true }).click()
    await bar().getByText('First direction.', { exact: false }).waitFor()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await bar().getByText('Second direction.', { exact: false }).waitFor()
    await bar().getByRole('button', { name: '+1 more', exact: true }).waitFor()
  })

  it('keeps a partially deleted selection scoped and offers only dismissal when nothing remains', async () => {
    const reason = 'Organize only these selected results.'
    const proposal = await propose(reason)
    await apply([{ op: 'node.delete', nodeId: ids[0]! }])
    await bar().getByRole('button', { name: 'Preview', exact: true }).click()
    await dialog().getByText(reason, { exact: true }).waitFor()
    expect(await dialog().locator('.vis-preview-node').count()).toBe(2)
    await dialog().getByRole('button', { name: 'Cancel', exact: true }).click()
    await apply(ids.slice(1).map(nodeId => ({ op: 'node.delete', nodeId })))
    const other = await apply([{ op: 'node.create', tempId: 'other', kind: 'image', title: 'Outside selection', x: 500, y: 500 }])
    await page.locator(`.react-flow__node[data-id="${other.idMap.other}"]`).waitFor()
    const before = layout(await nodes())
    await bar().getByRole('button', { name: 'Preview', exact: true }).click()
    await dialog().getByText('There is nothing left to organize.', { exact: true }).waitFor()
    expect(await dialog().getByRole('button', { name: 'Organize', exact: true }).count()).toBe(0)
    expect(await dialog().getByRole('button', { name: 'Cancel', exact: true }).count()).toBe(0)
    await dialog().getByRole('button', { name: 'Dismiss', exact: true }).click()
    await expect.poll(async () => (await proposals()).find(value => value.proposalId === proposal.proposalId)?.status).toBe('dismissed')
    expect(layout(await nodes())).toEqual(before)
  })
})
