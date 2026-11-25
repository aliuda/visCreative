import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { chromePath } from './platform'

it.skipIf(!existsSync(chromePath())).each(['Delete', 'Backspace'])('Deletes after a drag when an unrelated key was released with different casing (%s)', async key => {
  const bundle = await build({
    stdin: {
      resolveDir: resolve(import.meta.dirname, '..'), loader: 'tsx',
      contents: `
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { LocaleProvider } from '@vis/ui-kit'
        import { CanvasView } from '../../packages/canvas/ui/src/CanvasView'
        const root = createRoot(document.getElementById('canvas'))
        let nodes = [{
          nodeId: 'text', kind: 'text', x: 200, y: 180, w: 320, h: 240, z: 0, layoutRevision: 1,
          slots: [{ slotId: 'text', slotKey: 'main', revision: 1, content: { type: 'text', body: 'Draft' } }],
        }]
        const calls = []
        const noop = () => {}
        const actions = {
          onApply: async ops => {
            calls.push({ type: 'apply', ops })
            await Promise.resolve()
            nodes = nodes.map(node => {
              const layout = ops.find(op => op.op === 'node.layout' && op.nodeId === node.nodeId)
              return layout ? { ...node, ...layout, layoutRevision: node.layoutRevision + 1 } : node
            })
            render()
          },
          onDelete: ids => {
            calls.push({ type: 'delete', ids })
            nodes = nodes.filter(node => !ids.includes(node.nodeId))
            render()
          },
          onLayout: noop, onMove: noop, onTextCommit: async () => 'ok',
          onCreateText: noop, onCreateGenNode: noop, onSetInputs: noop, onExtend: noop,
          onGenerate: noop, onClone: noop, onExtendReferences: noop, onDownload: noop, onDropFiles: noop,
        }
        const render = () => flushSync(() => root.render(<LocaleProvider locale="en" setLocale={noop}>
          <CanvasView {...actions} nodes={nodes} assetUrl={id => id} />
        </LocaleProvider>))
        window.snapshot = () => ({ nodes, calls })
        render()
      `,
    },
    outfile: 'canvas.js', bundle: true, write: false, format: 'iife', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"development"', 'import.meta.env.DEV': 'false' },
  })
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setContent('<div id="canvas" style="display:flex;width:1500px;height:900px"></div>')
    await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text })
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text })
    const label = page.locator('.vis-node-label')
    await label.hover()
    // A physical key can have different keydown/keyup casing when Shift is released first.
    await page.keyboard.down('Shift')
    await page.keyboard.down('Y')
    await page.keyboard.up('Shift')
    await page.keyboard.up('y')
    const header = (await label.boundingBox())!
    await page.mouse.move(header.x + 20, header.y + 8)
    await page.mouse.down()
    await page.mouse.move(header.x + 120, header.y + 68, { steps: 8 })
    await page.mouse.up()
    const snapshot = () => page.evaluate(() => (window as any).snapshot())
    await expect.poll(async () => (await snapshot()).nodes[0].x).toBeGreaterThan(200)
    await label.click()
    await page.keyboard.press(key)
    await expect.poll(async () => (await snapshot()).calls.filter((call: any) => call.type === 'delete')).toEqual([{ type: 'delete', ids: ['text'] }])
    await expect.poll(() => page.locator('.react-flow__node').count()).toBe(0)
    expect((await snapshot()).calls.filter((call: any) => call.type === 'apply')).toHaveLength(1)
    expect(errors).toEqual([])
  } finally { await browser.close() }
}, 15_000)
