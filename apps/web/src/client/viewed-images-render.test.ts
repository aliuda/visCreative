import { existsSync } from 'node:fs'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromePath } from '../../e2e/platform'

let browser: Browser
let page: Page
let bundle: string
const cacheEntries = async (): Promise<[string, { status: string; asset?: unknown }][]> => page.evaluate('window.cacheEntries()')
const settled = () => expect.poll(async () => {
  const entries = await cacheEntries()
  return entries.length === await page.evaluate('window.expected') && entries.every(([, entry]) => entry.status !== 'pending')
}, { timeout: 8000 }).toBe(true)

describe.skipIf(!existsSync(chromePath()))('Viewed image disclosures and session cache', () => {
  beforeAll(async () => {
    const result = await build({
      stdin: { contents: `
        import { createElement } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { LocaleProvider } from '@vis/ui-kit'
        import { WorkBlock } from '../../../../packages/workbench/ui/src/WorkBlock'
        import { workTranscript } from '../../../../packages/workbench/ui/src/workBlocks'
        import { useViewedImagePaths } from '../../../../packages/workbench/ui/src/ViewedImages'
        const root = createRoot(document.getElementById('root'))
        const noop = () => {}
        let mode = 'blocks', expanded = true, count = 1, images = true, sessionId = 'a', items = []
        const listeners = new Set()
        window.calls = []
        window.reads = 0
        window.toggles = 0
        window.pending = []
        const asset = path => ({ assetId: 'asset:' + path, assetVersionId: 'version:' + path, kind: 'image', displayName: path })
        const record = (id, kind, payload) => ({ itemId: id, turnId: 'turn', kind, payload, createdSeq: 1, revision: 1, createdAt: 1000, updatedAt: 2000 })
        const records = (paths, viewed = true) => paths.flatMap((path, index) => [
          record('call-' + index, 'tool_call', { toolUseId: '' + index, name: 'read', input: { path }, ...(viewed ? { viewedImages: [{ path }] } : {}) }),
          record('result-' + index, 'tool_result', { toolUseId: '' + index, text: '{}' }),
        ])
        const host = {
          onAssetVersionsChanged: listener => { listeners.add(listener); return () => listeners.delete(listener) },
          resolveViewedPaths: async paths => {
            window.calls.push(paths)
            if (window.fail) throw new Error('Resolution failed')
            if (window.hold) await new Promise(resolve => window.pending.push(resolve))
            return { results: paths.map(path => path.includes('scratch') ? null : asset(path)) }
          },
        }
        window.emit = ids => { for (const listener of listeners) listener(ids) }
        function Cache() {
          const resolutions = useViewedImagePaths(sessionId, items, host)
          window.cacheEntries = () => [...resolutions]
          return createElement('output', { 'aria-label': 'Cache entries' }, JSON.stringify([...resolutions]))
        }
        function Blocks() {
          const paths = Array.from({ length: count }, (_, index) => '/image-' + index + '.png')
          const entries = records(paths, images)
          const block = workTranscript(entries)[0]
          const resolutions = new Map(paths.map(path => [path, { status: 'ready', asset: asset(path) }]))
          return createElement('section', { 'aria-label': 'Transcript test' }, createElement(WorkBlock, { block, items: entries, expanded,
            onToggle: () => window.toggles++, viewedImages: { resolutions, assetUrl: () => 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/%3E', onOpenAsset: noop } }))
        }
        window.configure = (next = {}) => {
          if (next.mode) mode = next.mode
          if (next.expanded !== undefined) expanded = next.expanded
          if (next.count !== undefined) count = next.count
          if (next.images !== undefined) images = next.images
          if (next.sessionId !== undefined) sessionId = next.sessionId
          if (next.paths) items = next.paths.map((path, index) => record('cache-' + index, 'tool_call', { get viewedImages() { window.reads++; return [{ path }] } }))
          window.expected = sessionId ? items.length : 0
          flushSync(() => root.render(createElement(LocaleProvider, { locale: 'en', setLocale: noop }, createElement(mode === 'cache' ? Cache : Blocks))))
        }
      `, resolveDir: import.meta.dirname, loader: 'tsx' },
      bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
    bundle = result.outputFiles[0]!.text
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    page = await browser.newPage()
    page.setDefaultTimeout(8000)
    await page.setContent('<div id="root"></div>')
    await page.addScriptTag({ content: bundle })
  })
  afterEach(async () => { await page?.close() })
  afterAll(async () => { await browser?.close() }, 30_000)

  it('keeps ordinary work blocks native after the browser opens their details', async () => {
    await page.evaluate('window.configure({ images: false, expanded: false })')
    const block = page.getByRole('region', { name: 'Transcript test' }).locator('details').first()
    expect(await block.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
    await block.evaluate((element: HTMLDetailsElement) => { element.open = true })
    await expect.poll(() => page.evaluate('window.toggles')).toBeGreaterThan(0)
    await page.evaluate('window.configure()')
    await block.locator('summary').first().click()
    expect(await block.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
    await block.locator('summary').first().click()
    expect(await block.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true)
  })

  it('only auto-opens image disclosures and preserves native and author choices across later turns', async () => {
    await page.evaluate('window.configure()')
    const work = page.getByRole('region', { name: 'Transcript test' }).locator('details').first()
    const images = page.getByRole('group', { name: 'Viewed 1 images', exact: true })
    expect(await images.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true)
    await page.evaluate('window.configure({ expanded: false })')
    expect(await work.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true)
    expect(await images.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true)
    await images.getByText('Viewed 1 images', { exact: true }).click()
    await expect.poll(() => images.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
    await page.evaluate('window.configure({ expanded: true })')
    expect(await images.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
    await images.evaluate((element: HTMLDetailsElement) => { element.open = true })
    await expect.poll(() => images.evaluate((element: HTMLDetailsElement) => element.open)).toBe(true)
    await page.evaluate('window.configure()')
    await images.getByText('Viewed 1 images', { exact: true }).click()
    expect(await images.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
    await work.locator('summary').first().click()
    await page.evaluate('window.configure({ expanded: false }); window.configure({ expanded: true })')
    expect(await work.evaluate((element: HTMLDetailsElement) => element.open)).toBe(false)
  })

  it('shows all twelve tiles and starts overflow only at thirteen', async () => {
    await page.evaluate('window.configure({ count: 12 })')
    const twelve = page.getByRole('group', { name: 'Viewed 12 images', exact: true })
    expect(await twelve.locator('img').count()).toBe(12)
    expect(await twelve.getByRole('button', { name: /more images/ }).count()).toBe(0)
    await page.evaluate('window.configure({ count: 13 })')
    const thirteen = page.getByRole('group', { name: 'Viewed 13 images', exact: true })
    expect(await thirteen.locator('img').count()).toBe(11)
    await thirteen.getByRole('button', { name: 'Show 2 more images', exact: true }).click()
    expect(await thirteen.locator('img').count()).toBe(13)
  })

  it('memoizes path validation by transcript identity and batches uncached paths at sixty-four', async () => {
    await page.evaluate('window.configure({ mode: "cache", paths: Array.from({ length: 130 }, (_, index) => "/" + index + ".png") })')
    await settled()
    expect(await page.evaluate('window.calls.map(paths => paths.length)')).toEqual([64, 64, 2])
    const reads = await page.evaluate('window.reads')
    expect(reads).toBeGreaterThan(0)
    await page.evaluate('for (let index = 0; index < 5; index++) window.configure()')
    expect(await page.evaluate('window.reads')).toBe(reads)
    expect(await page.evaluate('window.calls.length')).toBe(3)
  })

  it('bounds error retries per open and never retries errors or null entries on asset events', async () => {
    await page.evaluate('window.configure({ mode: "cache", paths: ["/scratch.png"] })')
    await settled()
    await page.evaluate('window.fail = true; window.configure({ paths: ["/scratch.png", "/frame.png"] })')
    await expect.poll(() => page.evaluate('window.calls.length')).toBe(3)
    await settled()
    expect((await cacheEntries())[1]?.[1].status).toBe('error')
    await page.evaluate('window.fail = false; for (let index = 0; index < 20; index++) window.emit(["unrelated", "asset:/frame.png"])')
    expect(await page.evaluate('window.calls')).toEqual([['/scratch.png'], ['/frame.png'], ['/frame.png']])
    expect((await cacheEntries())[1]?.[1].status).toBe('error')
    await page.evaluate('window.configure({ sessionId: null }); window.configure({ sessionId: "a" })')
    await settled()
    expect(await page.evaluate('window.calls[3]')).toEqual(['/frame.png'])
    await page.evaluate('window.emit(["unrelated"])')
    expect(await page.evaluate('window.calls.length')).toBe(4)
    await page.evaluate('window.emit(["asset:/frame.png"])')
    await settled()
    expect(await page.evaluate('window.calls[4]')).toEqual(['/frame.png'])
  })

  it('retains four sessions in opening order, invalidates inactive assets, and evicts the least recent session', async () => {
    for (const sessionId of ['a', 'b', 'c', 'd']) {
      await page.evaluate(`window.configure({ mode: 'cache', sessionId: '${sessionId}', paths: ['/${sessionId}.png'] })`)
      await settled()
    }
    expect(await page.evaluate('window.calls.length')).toBe(4)
    await page.evaluate('window.emit(["asset:/a.png"])')
    expect(await page.evaluate('window.calls.length')).toBe(4)
    await page.evaluate('window.configure({ sessionId: "a", paths: ["/a.png"] })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(5)
    await page.evaluate('window.configure({ sessionId: "e", paths: ["/e.png"] })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(6)
    await page.evaluate('window.configure({ sessionId: "a", paths: ["/a.png"] })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(6)
    await page.evaluate('window.configure({ sessionId: "b", paths: ["/b.png"] })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(7)
    await page.evaluate('window.configure({ sessionId: null })')
    expect(await cacheEntries()).toEqual([])
    await page.evaluate('window.configure({ sessionId: "b" })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(7)
  })

  it('retries a cached failure only once on reopening without an asset-event retry storm', async () => {
    await page.evaluate('window.fail = true; window.configure({ mode: "cache", paths: ["/bad.png"] })')
    await expect.poll(() => page.evaluate('window.calls.length')).toBe(2)
    await settled()
    await page.evaluate('window.fail = false; window.configure({ sessionId: "b", paths: ["/other.png"] })')
    await settled()
    expect((await cacheEntries()).map(([path]) => path)).toEqual(['/other.png'])
    await page.evaluate('window.fail = true; window.configure({ sessionId: "a", paths: ["/bad.png"] })')
    await settled()
    await page.evaluate('window.configure(); window.configure()')
    expect(await page.evaluate('window.calls.length')).toBe(4)
    await page.evaluate('for (let index = 0; index < 20; index++) window.emit(["asset:/bad.png"])')
    expect(await page.evaluate('window.calls.length')).toBe(4)
    await page.evaluate('window.configure({ sessionId: null })')
    expect(await cacheEntries()).toEqual([])
    expect(await page.evaluate('window.calls.length')).toBe(4)
    await page.evaluate('window.fail = false; window.configure({ sessionId: "a" })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(5)
    expect((await cacheEntries())[0]?.[1].status).toBe('ready')
  })

  it('retains inactive replies without changing the current view and retries invalidated pending metadata', async () => {
    await page.evaluate('window.hold = true; window.configure({ mode: "cache", paths: ["/old.png"] })')
    await expect.poll(() => page.evaluate('window.pending.length')).toBe(1)
    await page.evaluate('window.configure({ sessionId: "b", paths: ["/new.png"] })')
    await expect.poll(() => page.evaluate('window.pending.length')).toBe(2)
    await page.evaluate('window.pending.shift()()')
    expect((await cacheEntries()).map(([path]) => path)).toEqual(['/new.png'])
    await page.evaluate('window.emit(["asset:/new.png"]); window.hold = false; window.pending.shift()()')
    await settled()
    expect(await page.evaluate('window.calls')).toEqual([['/old.png'], ['/new.png'], ['/new.png']])
    expect((await cacheEntries())[0]?.[1].status).toBe('ready')
    await page.evaluate('window.configure({ sessionId: "a", paths: ["/old.png"] })')
    await settled()
    expect(await page.evaluate('window.calls.length')).toBe(3)
  })
})
