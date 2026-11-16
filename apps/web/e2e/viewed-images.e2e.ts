import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockProvider } from '../../../packages/generation/src/index'
import { studiodEndpoint } from '../../../runtime/studiod-endpoint'
import { codexRuntime } from '../../../services/studiod/src/codex'
import { createMemorySecretStore } from '../../../services/studiod/src/secret-store'
import { startStudiod, type Studiod } from '../../../services/studiod/src/studiod'
import { createWebHost, type WebHost } from '../src/host/server'
import { openStudiodLink, type StudiodLink } from '../src/host/studiod-link'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
let dir: string
let daemon: Studiod
let host: WebHost
let admin: StudiodLink
let browser: Browser
let page: Page
let sessionId: string
const versionIds: string[] = []
const assetIds: string[] = []
const errors: string[] = []
const assetRequests: { method: string; params: { paths?: string[] } }[] = []
const images = [['Canvas image', 'steelblue'], ['Preview image', 'coral'], ['Second angle', 'seagreen'], ['Detail frame', 'mediumpurple']] as const

describe('Viewed images in the transcript', () => {
  beforeAll(async () => {
    expect(existsSync(join(root, 'apps/web/dist/client/index.html'))).toBe(true)
    dir = mkdtempSync(join(tmpdir(), 'vis-viewed-images-'))
    vi.stubEnv('VIS_PROJECTS_DIR', join(dir, 'projects'))
    daemon = await startStudiod({
      dataDir: dir, studiodVersion: 'viewed-images-e2e', secretStore: createMemorySecretStore(),
      providers: [createMockProvider({ latencyMs: 0 })], defaults: { image: { provider: 'mock' } },
      runtimes: { codex: codexRuntime({ dataDir: dir, socketPath: studiodEndpoint(dir), codexPath: join(root, 'apps/web/e2e/fake-codex.mjs'), visMcp: { command: process.execPath, args: [join(root, 'apps/cli/dist/vis.mjs'), 'mcp'] } }) },
    })
    const spaceId = daemon.spaces.create('Viewed images').spaceId
    admin = await openStudiodLink({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath })
    await admin.call('events.subscribe', { spaceId })
    for (const [name, color] of images) {
      const path = join(dir, `${color}.png`)
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=160x90`, '-frames:v', '1', '-y', path])
      const asset = await admin.call('asset.import', { requestId: crypto.randomUUID(), path, displayName: name })
      versionIds.push(asset.assetVersionId)
      assetIds.push(asset.assetId)
    }
    await admin.call('canvas.apply', { requestId: crypto.randomUUID(), ops: [{ op: 'node.create', tempId: 'source', kind: 'image', title: 'Viewed canvas image', content: { assetVersionId: versionIds[0]! } }] })
    sessionId = (await admin.call('session.create', { requestId: crypto.randomUUID(), title: 'Image partner', agentKind: 'codex' })).sessionId
    host = await createWebHost({ socketPath: daemon.socketPath, tokenPath: daemon.tokenPath, staticDir: join(root, 'apps/web/dist/client') })
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framesent', frame => {
      const message = JSON.parse(frame.payload.toString())
      if (message.method === 'asset.resolvePaths' || message.method === 'asset.versions') assetRequests.push(message)
    }))
    await page.addInitScript(() => localStorage.setItem('vis.session.width', '560'))
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await page.getByRole('listitem', { name: /^Image partner,/ }).click()
  })
  afterAll(async () => {
    await browser?.close()
    admin?.close()
    await host?.close()
    await daemon?.stop('user_quit')
    vi.unstubAllEnvs()
    if (dir) removeTempDir(dir)
  })

  it('shows two registered thumbnails and one scratch placeholder, locates a node, and previews an unused asset', async () => {
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: `view-images ${JSON.stringify({ assetVersionIds: versionIds.slice(0, 2), scratch: 1 })}`, refs: [] })
    await page.getByText('viewed-images-done', { exact: true }).waitFor()
    const block = page.getByRole('group', { name: 'Viewed 3 images', exact: true })
    await block.getByText('Viewed 3 images', { exact: true }).waitFor()
    await expect.poll(() => block.locator('img').count(), { timeout: 8000 }).toBe(2)
    for (const name of ['Canvas image', 'Preview image']) {
      await expect.poll(() => block.getByRole('img', { name, exact: true }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 8000 }).toBe(true)
    }
    const placeholder = block.getByRole('img', { name: 'Not a project asset', exact: true })
    await placeholder.getByText(/^scratch-\d+\.png$/).waitFor()
    expect(await placeholder.getAttribute('title')).toMatch(/[/\\]scratch-\d+\.png$/)
    expect(await placeholder.getByRole('button').count()).toBe(0)
    await page.screenshot({ path: join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rfc0051-ui.png'), animations: 'disabled' })
    await block.getByRole('button', { name: 'Canvas image', exact: true }).click()
    await page.getByRole('button', { name: 'Extend node', exact: true }).waitFor()
    expect(await page.getByRole('dialog', { name: /^Attachment preview:/ }).count()).toBe(0)
    await block.getByRole('button', { name: 'Preview image', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'Attachment preview: Preview image', exact: true })
    await preview.getByRole('img', { name: 'Preview image', exact: true }).waitFor()
    await preview.getByRole('button', { name: 'Close attachment preview', exact: true }).click()
    await block.getByText('Show details', { exact: true }).click()
    await block.getByText('view_image', { exact: true }).first().click()
    expect(await block.getByText('Show details', { exact: true }).evaluate(element => (element.parentElement as HTMLDetailsElement).open)).toBe(true)
    expect(errors).toEqual([])
  })

  it('wraps five equal cards and invalidates a renamed asset without querying version lists', async () => {
    await admin.call('session.sendMessage', { requestId: crypto.randomUUID(), sessionId, text: `view-images ${JSON.stringify({ assetVersionIds: versionIds, scratch: 1 })}`, refs: [] })
    const block = page.getByRole('group', { name: 'Viewed 5 images', exact: true })
    await block.getByText('Viewed 5 images', { exact: true }).waitFor()
    await expect.poll(() => block.locator('img').count(), { timeout: 8000 }).toBe(4)
    for (const [name] of images) await expect.poll(() => block.getByRole('img', { name, exact: true }).evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), { timeout: 8000 }).toBe(true)
    const placeholder = block.getByRole('img', { name: 'Not a project asset', exact: true })
    await placeholder.getByText(/^scratch-\d+\.png$/).waitFor()
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    const cards = await Promise.all(images.map(([name]) => block.getByRole('button', { name, exact: true }).evaluate(box)))
    cards.push(await placeholder.evaluate(box))
    for (const card of cards) {
      expect(card.width).toBeGreaterThanOrEqual(120)
      expect(card.width).toBeLessThanOrEqual(168)
      expect(card.width / card.height).toBeCloseTo(1.6, 1)
      expect(card.width).toBeCloseTo(cards[0]!.width, 1)
      expect(card.height).toBeCloseTo(cards[0]!.height, 1)
    }
    expect(cards[2]!.y).toBeCloseTo(cards[0]!.y, 1)
    expect(cards[3]!.y).toBeGreaterThan(cards[0]!.y + cards[0]!.height)
    expect(cards[4]!.y).toBeCloseTo(cards[3]!.y, 1)
    expect(await block.getByRole('img', { name: 'Canvas image', exact: true }).evaluate(element => getComputedStyle(element).objectFit)).toBe('contain')
    expect(await placeholder.getByText('Not a project asset', { exact: true }).evaluate(element => getComputedStyle(element).whiteSpace)).toBe('nowrap')
    await block.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(process.platform === 'win32' ? tmpdir() : '/tmp', 'rfc0051-ui-v2.png'), animations: 'disabled' })
    const versionRequests = assetRequests.filter(request => request.method === 'asset.versions').length
    const pathRequests = assetRequests.filter(request => request.method === 'asset.resolvePaths').length
    const asset = (await admin.call('asset.list', {})).items.find((asset: { assetId: string }) => asset.assetId === assetIds[0])!
    await admin.call('asset.update', { assetId: asset.assetId, expectedRevision: asset.revision, displayName: 'Renamed canvas image' })
    await block.getByRole('button', { name: 'Renamed canvas image', exact: true }).waitFor()
    const invalidation = assetRequests.filter(request => request.method === 'asset.resolvePaths').slice(pathRequests)
    expect(invalidation).toHaveLength(1)
    expect(invalidation[0]!.params.paths).toEqual([(await admin.call('asset.get', { assetVersionId: versionIds[0] })).path])
    expect(assetRequests.filter(request => request.method === 'asset.versions')).toHaveLength(versionRequests)
    expect(errors).toEqual([])
  })
})
