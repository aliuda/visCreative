import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const shots = '/tmp/vis-canvas-layout-protected'
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let nodeId: string
let sessionId: string
const errors: string[] = []

beforeAll(async () => {
  expect(existsSync(join(root, 'apps/web/dist/client/index.html'))).toBe(true)
  mkdirSync(shots, { recursive: true })
  dir = mkdtempSync(join(tmpdir(), 'vis-canvas-layout-protected-'))
  vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
  daemon = await startStudiod({ dataDir: dir, studiodVersion: 'canvas-layout-protected-e2e', secretStore: createMemorySecretStore(),
    providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
    runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'),
      visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) } })
  const spaceId = daemon.spaces.create('Protected canvas layout').spaceId
  admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
  await admin.call('events.subscribe', { spaceId })
  nodeId = (await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [
    { op: 'node.create', tempId: 'result', kind: 'image', title: 'Author arrangement', x: 100, y: 100 },
  ] })).idMap.result!
  sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Layout partner', agentKind: 'codex' })).sessionId
  host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
  browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  page.setDefaultTimeout(10_000)
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(host.url, { waitUntil: 'domcontentloaded' })
  await page.getByRole('listitem', { name: /^Layout partner,/ }).click()
})
afterEach(async ({ task }) => {
  if (task.result?.state === 'fail' && page) await page.screenshot({ path: join(shots, 'failure.png'), animations: 'disabled' })
})
afterAll(async () => {
  await browser?.close()
  admin?.close()
  await host?.close()
  await daemon?.stop('user_quit')
  vi.unstubAllEnvs()
  if (dir) removeTempDir(dir)
})

it('refuses a fake Codex move through MCP and shows the gateway refusal while preserving the author layout', async () => {
  const before = (await admin.call('canvas.get', { nodeIds: [nodeId] })).nodes[0]!
  await page.getByRole('textbox', { name: 'Message the Agent', exact: true }).fill(`canvas-layout-protected ${JSON.stringify({ nodeId })}`)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByText('Completed canvas layout protection', { exact: true }).waitFor()
  await vi.waitFor(async () => {
    expect((await admin.call('session.list')).sessions.find(session => session.sessionId === sessionId)?.activeTurnId).toBeNull()
  }, { timeout: 10_000 })
  const { items } = await admin.call('session.getTranscript', { sessionId })
  const call = items.find(item => item.kind === 'tool_call' && item.payload.name === 'vis.canvas_apply')!
  const result = items.find(item => item.kind === 'tool_result' && item.payload.toolUseId === call.payload.toolUseId)!
  expect(call.payload.input).toMatchObject({ ops: [{ op: 'node.layout', nodeId, x: before.x + 400 }] })
  expect(result.payload.isError).toBe(true)
  expect(JSON.parse(result.payload.text as string)).toMatchObject({ code: 'forbidden', reason: 'canvas.layout_protected', params: { nodeId } })
  expect((await admin.call('canvas.get', { nodeIds: [nodeId] })).nodes).toEqual([before])
  const output = page.getByText(result.payload.text as string, { exact: true }).last()
  const details = page.locator('details').filter({ has: output })
  for (let index = 0; index < await details.count(); index++) {
    const detail = details.nth(index)
    if (await detail.getAttribute('open') === null) await detail.locator(':scope > summary').click()
  }
  await output.waitFor({ state: 'visible' })
  expect(errors).toEqual([])
})
