import { existsSync, readFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium, type Browser, type Page } from 'playwright-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chromePath, removeTempDir } from './platform'

const root = fileURLToPath(new URL('../../../', import.meta.url))
let browser: Browser
let page: Page
let script: string
let fixtureDir: string
const errors: string[] = []
const styles = readFileSync(join(root, 'packages/timeline/ui/src/timeline-area.css'), 'utf8') + readFileSync(join(root, 'packages/timeline/ui/src/overlay/overlay.css'), 'utf8')

describe.skipIf(!existsSync(chromePath()))('Timeline key refusal recovery', () => {
  beforeAll(async () => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'vis-key-permission-'))
    const video = join(fixtureDir, 'source.mp4')
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=gray:size=320x180:rate=10:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', video], { windowsHide: true })
    const videoUrl = 'data:video/mp4;base64,' + readFileSync(video).toString('base64')
    const result = await build({
      stdin: { contents: `
        import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
        import { createRoot } from 'react-dom/client'
        import { flushSync } from 'react-dom'
        import { createTimelineDraft } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/draft.ts'))}
        import { LocaleProvider, useMessages } from ${JSON.stringify(join(root, 'packages/ui-kit/src/index.ts'))}
        import { clipDurationMs } from ${JSON.stringify(join(root, 'packages/protocol/src/index.ts'))}
        import { KeyLane } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/KeyLane.tsx'))}
        import { CropEditor } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/CropEditor.tsx'))}
        import { TransformInspector } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/TransformInspector.tsx'))}
        import { useMediaResources } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/model/resources.ts'))}
        import { TimelineArea } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/TimelineArea.tsx'))}
        import { TransformEditorContext, useTransformEditorState, useClipAspectLock } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/transform-context.tsx'))}
        import { OverlayLayer } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/overlay/OverlayLayer.tsx'))}
        import { timelineEditorMessages } from ${JSON.stringify(join(root, 'packages/timeline/ui/src/messages.ts'))}
        const crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }
        const original = { id: 'clip', startMs: 500, inMs: 1000, outMs: 5000, speed: 2, volume: 1, fadeInMs: 0, fadeOutMs: 0,
          source: { nodeId: 'source', assetVersionId: 'asset' }, overlay: { x: 0.5, y: 0.5, width: 0.2, opacity: 1 },
          crop: { keys: [0, 1000, 3000, 5000, 7000].map(t => ({ t, value: crop, ease: 'linear' })) } }
        function Harness() {
          const m = useMessages(timelineEditorMessages)
          const [doc, setDoc] = useState({ version: 1, tracks: [{ id: 'track', kind: 'overlay', volume: 1, muted: false, clips: [original] }] })
          window.setClipValues = (speed, outMs = 5000) => setDoc({ ...doc, tracks: [{ ...doc.tracks[0], clips: [{ ...original, speed, outMs }] }] })
          const [message, setMessage] = useState('')
          const [position, setPosition] = useState(200)
          const now = useRef(200)
          const calls = useRef(0)
          const mode = useRef(null)
          window.refuseTransform = value => { mode.current = value }
          const draft = {
            get doc() { return mode.current === 'invalid' ? { ...doc, tracks: [{ ...doc.tracks[0], volume: 3 }] } : doc },
            get conflict() { return mode.current === 'conflict' ? { theirs: doc, revision: 2 } : null },
            edit(next) { calls.current++; if (mode.current === 'captions') return 'captions'; setDoc(next) },
          }
          const clock = { now: () => now.current, pause() {}, playing: () => false, play() {}, subscribe: () => () => {}, seek(t) { now.current = t; setPosition(t) } }
          return <><p role="status" aria-label="Playhead">{position}</p><p role="status" aria-label="Playback speed">{doc.tracks[0].clips[0].speed}</p><p role="status" aria-label="Edit count">{calls.current}</p><p role="alert">{message}</p>
            <button onClick={() => clock.seek(200)}>Seek outside clip</button>
            <div style={{ position: 'relative', width: 600, height: 64, marginTop: 40 }}>
              <span role="img" aria-label="Clip extent" style={{ position: 'absolute', left: 50, width: Math.max(2, clipDurationMs(doc.tracks[0].clips[0]) / 10 - 1), height: 64 }} />
              <KeyLane clip={doc.tracks[0].clips[0]} draft={draft} clock={clock} zoom={100} fps={10} onRefused={reason => setMessage(reason ? m[reason] : '')} />
            </div></>
        }
        const capped = value => ({ keys: Array.from({ length: 32 }, (_, i) => ({ t: i === 31 ? 2002 : 1000 + i * 30, value, ease: 'linear' })) })
        const overlayClip = { id: 'source-end', startMs: 0, inMs: 1000, outMs: 2002, speed: 4, volume: 1, fadeInMs: 0, fadeOutMs: 0,
          source: { nodeId: 'clamp-source', assetVersionId: 'clamp-asset' }, overlay: { x: capped(0.5), y: capped(0.15), width: 0.2, opacity: 1 } }
        let overlayPosition = 250.9
        let audioContext
        const overlayClock = { now: () => overlayPosition, context: () => audioContext ??= new AudioContext(), pause() {}, playing: () => false, play() {}, seek() {}, subscribe: () => () => {} }
        const overlayHost = { node: { nodeId: 'clamp-timeline' }, nodes: [{ nodeId: 'clamp-source', kind: 'video', title: 'Clamp source', slots: [] }, { nodeId: 'second-clamp-source', kind: 'video', title: 'Second clamp source', slots: [] }],
          assetUrl: () => ${JSON.stringify(videoUrl)}, filmstripUrl: () => '', preview: async () => ({ kind: 'filmstrip', frames: 1, intervalMs: 1000 }), assetInfo: async () => ({ kind: 'video', width: 320, height: 180, durationMs: 3000 }) }
        const overlayOutput = { width: 320, height: 180 }
        function OverlayHarness() {
          const [doc, setDoc] = useState({ version: 1, tracks: [{ id: 'overlay', kind: 'overlay', volume: 1, muted: false, clips: [overlayClip] }] })
          const mode = useRef(null)
          const [selection, select] = useState(['source-end'])
          const [invalid, setInvalid] = useState(false)
          const invalidDoc = useMemo(() => ({ ...doc, tracks: [{ ...doc.tracks[0], volume: 3 }] }), [doc])
          const playing = useRef(false)
          const clock = useRef({ ...overlayClock, playing: () => playing.current })
          window.showLimitedOverlays = () => {
            playing.current = true
            setDoc(previous => ({ ...previous, tracks: [...previous.tracks, { ...previous.tracks[0], id: 'second-overlay', clips: [{ ...overlayClip, id: 'second-source', source: { ...overlayClip.source, nodeId: 'second-clamp-source' } }] }] }))
          }
          window.expireOverlayNotice = reason => {
            if (reason === 'selection') select([])
            else if (reason === 'content') setDoc(previous => ({ ...previous, tracks: previous.tracks.map(track => ({ ...track, volume: 0.9 })) }))
            else setDoc(previous => ({ ...previous, tracks: previous.tracks.map(track => ({ ...track, clips: track.clips.filter(clip => clip.id !== 'source-end') })) }))
          }
          window.restoreOverlaySelection = () => select(['source-end'])
          window.unselectOverlay = () => select([])
          window.refuseTransform = value => { mode.current = value; flushSync(() => setInvalid(value === 'invalid')) }
          window.overlayDocument = () => doc
          window.restoreMissingOverlay = () => flushSync(() => setDoc(previous => ({ ...previous, tracks: [{ ...previous.tracks[0], clips: [overlayClip] }] })))
          window.capAllOverlayAxes = () => { overlayPosition = 200; setDoc(previous => ({ ...previous, tracks: [{ ...previous.tracks[0], clips: [overlayClip] }] })) }
          window.removeOverlayDuringGesture = () => flushSync(() => setDoc(previous => ({ ...previous, tracks: previous.tracks.map(track => ({ ...track, clips: [] })) })))
          window.prepareOverlayResize = () => { overlayPosition = 125; setDoc({ ...doc, tracks: [{ ...doc.tracks[0], clips: [{ ...overlayClip, overlay: { x: 0.5, y: 0.5, width: 0.2, opacity: 1 } }] }] }) }
          window.capOverlayDuringGesture = () => flushSync(() => setDoc(previous => ({ ...previous, tracks: [{ ...previous.tracks[0], clips: previous.tracks[0].clips.map(clip => ({ ...clip, overlay: { ...clip.overlay, width: capped(0.2) } })) }] })))
          window.showCappedAxis = (x = 0.5) => { overlayPosition = 200; setDoc({ ...doc, tracks: [{ ...doc.tracks[0], clips: [{ ...overlayClip, overlay: { ...overlayClip.overlay, x: capped(x), y: 0.15 } }] }] }) }
          const draft = {
            baseRevision: 0,
            doc: invalid ? invalidDoc : doc,
            get conflict() { return mode.current === 'conflict' ? { theirs: doc, revision: 2 } : null },
            edit(next) { if (mode.current === 'captions') return 'captions'; setDoc(next) },
          }
          return <div style={{ position: 'relative', width: 320, height: 180 }}>
            <OverlayLayer host={overlayHost} draft={draft} clock={clock.current} selection={selection} select={select} output={overlayOutput} onStateChange={state => { window.overlayPreviewState = state }} />
          </div>
        }
        function CropHarness() {
          const clip = { ...overlayClip, crop }
          const [doc, setDoc] = useState({ version: 1, tracks: [{ id: 'overlay', kind: 'overlay', volume: 1, muted: false, clips: [clip] }] })
          const mode = useRef(null)
          const [cropId, editCrop] = useState(clip.id)
          const transformEditor = useTransformEditorState(cropId, editCrop, doc)
          window.refuseTransform = value => { mode.current = value }
          window.cropDocument = () => doc
          window.prepareCropGesture = () => { overlayPosition = 125; setDoc(previous => ({ ...previous, tracks: [{ ...previous.tracks[0], clips: [{ ...clip, crop: { keys: [1000, 2002].map(t => ({ t, value: crop, ease: 'linear' })) } }] }] })) }
          window.capCropDuringGesture = () => { overlayPosition = 250.9; flushSync(() => setDoc(previous => ({ ...previous, tracks: [{ ...previous.tracks[0], clips: [{ ...clip, crop: capped(crop) }] }] }))) }
          window.setCropPosition = value => { overlayPosition = value }
          const draft = {
            get doc() { return mode.current === 'invalid' ? { ...doc, tracks: [{ ...doc.tracks[0], volume: 3 }] } : doc },
            get conflict() { return mode.current === 'conflict' ? { theirs: doc, revision: 2 } : null },
            edit(next) { if (mode.current === 'captions') return 'captions'; setDoc(next) },
          }
          return <div style={{ position: 'relative', width: 900, height: 600 }}><TransformEditorContext value={transformEditor}>
            <CropEditor clip={doc.tracks[0].clips[0]} host={overlayHost} draft={draft} clock={{ ...overlayClock, playing: () => true }} selection={[clip.id]} select={() => {}} output={overlayOutput} />
          </TransformEditorContext></div>
        }
        function SaveHarness() {
          const mode = useRef(null)
          const controller = useMemo(() => createTimelineDraft({ ...overlayHost,
            node: { nodeId: 'save-timeline', slots: [{ slotKey: 'main', revision: 1, content: { type: 'timeline', doc: { version: 1, tracks: [{ id: 'overlay', kind: 'overlay', volume: 1, muted: false, clips: [overlayClip] }] } } }] },
            commit: () => new Promise(resolve => { window.finishOverlaySave = () => resolve('ok') }),
          }), [])
          useEffect(() => () => controller.dispose(), [controller])
          const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
          window.refuseTransform = value => { mode.current = value }
          window.undoOverlay = () => controller.getSnapshot().undo()
          window.redoOverlay = () => controller.getSnapshot().redo()
          const draft = { ...snapshot, edit(next, options) { return mode.current === 'captions' ? 'captions' : snapshot.edit(next, options) } }
          return <><p role="status" aria-label="Save state">{snapshot.saveState}</p><p role="status" aria-label="Saved revision">{snapshot.baseRevision}</p>
            <div style={{ position: 'relative', width: 320, height: 180 }}><OverlayLayer host={overlayHost} draft={draft} clock={overlayClock} selection={['source-end']} select={() => {}} output={overlayOutput} onStateChange={() => {}} /></div></>
        }
        function TransformHarness({ unknown = false }) {
          const host = useMemo(() => unknown ? { ...overlayHost, node: { nodeId: 'unresolved-crop' }, assetUrl: () => 'data:video/mp4,',
            assetInfo: () => new Promise(resolve => { window.resolveCropInfo = () => resolve({ kind: 'video', width: 320, height: 180 }) }) } : overlayHost, [])
          const resources = useMediaResources(host, [overlayClip.source.assetVersionId])
          const info = resources.resolvedInfo(overlayClip.source.assetVersionId)
          const sourceAspect = info?.width && info.height ? info.width / info.height : undefined
          const [doc, setDoc] = useState({ version: 1, tracks: [{ id: 'main', kind: 'video', volume: 1, muted: false,
            clips: [{ ...overlayClip, overlay: undefined, crop: { ...crop, width: unknown ? 0.8 : 0.447 } }] }] })
          const clip = doc.tracks[0].clips[0]
          const [cropId, editCrop] = useState(clip.id)
          const editor = useTransformEditorState(cropId, editCrop, doc)
          const mode = useRef(null)
          window.refuseTransform = value => { mode.current = value }
          window.cropDocument = () => doc
          window.writeTransformCrop = value => setDoc(previous => ({ ...previous, tracks: [{ ...previous.tracks[0], clips: [{ ...previous.tracks[0].clips[0], crop: value }] }] }))
          const draft = {
            get doc() { return mode.current === 'invalid' ? { ...doc, tracks: [{ ...doc.tracks[0], volume: 3 }] } : doc },
            get conflict() { return mode.current === 'conflict' ? { theirs: doc, revision: 2 } : null },
            edit(next) { if (mode.current === 'captions') return 'captions'; setDoc(next) },
          }
          const parts = { clip, host, draft, clock: overlayClock, selection: [clip.id], select() {}, output: overlayOutput }
          return <TransformEditorContext value={editor}><TransformInspector {...parts} sourceAspect={sourceAspect} />
            <div style={{ position: 'relative', width: 900, height: 600 }}>{cropId && <CropEditor {...parts} />}</div>
          </TransformEditorContext>
        }
        const lockClip = { ...overlayClip, overlay: undefined }
        function LockRead({ clip }) {
          const lock = useClipAspectLock(clip, 16 / 9, 16 / 9)
          return <p role="status" aria-label="Stored aspect">{lock}</p>
        }
        function LockHarness() {
          const [clip, setClip] = useState(lockClip)
          const [cropId, editCrop] = useState(null)
          const doc = { version: 1, tracks: [{ id: 'main', kind: 'video', clips: clip ? [clip] : [] }] }
          const editor = useTransformEditorState(cropId, editCrop, doc)
          return <TransformEditorContext value={editor}>{clip ? <LockRead clip={clip} /> : <p role="status" aria-label="Stored aspect">Removed</p>}
            <button onClick={() => editor.setLock(clip.id, 'free')}>Choose Free</button>
            <button onClick={() => setClip({ ...lockClip, crop })}>Add crop externally</button>
            <button onClick={() => setClip({ ...lockClip, crop: { ...crop, width: 0.6 } })}>Write 4:3 crop</button>
            <button onClick={() => setClip(null)}>Remove locked clip</button>
            <button onClick={() => setClip({ ...lockClip, crop })}>Restore clip ID</button>
            <button onClick={() => setClip(lockClip)}>Undo crop</button>
          </TransformEditorContext>
        }
        function EmptyOverlayHarness() {
          const [doc, setDoc] = useState({ version: 1, tracks: [] })
          const [selection, select] = useState([])
          window.changeEmptyOverlayDoc = () => flushSync(() => setDoc(previous => ({ ...previous })))
          window.changeEmptyOverlaySelection = () => flushSync(() => select(['other']))
          return <OverlayLayer host={overlayHost} draft={{ doc, conflict: null }} clock={overlayClock} selection={selection} select={select} output={overlayOutput} onStateChange={() => {}} />
        }
        function AreaHarness() {
          const [doc, setDoc] = useState({ version: 1, output: { ...overlayOutput, fps: 10 }, tracks: [{ id: 'track', kind: 'overlay', volume: 1, muted: false, clips: [{ ...original, source: overlayClip.source }] }] })
          const mode = useRef(null)
          window.refuseTransform = value => { mode.current = value }
          const draft = { doc, conflict: null, edit(next) { if (mode.current === 'captions') return 'captions'; setDoc(next) } }
          return <div style={{ position: 'relative', width: 1000, height: 400 }}><TimelineArea host={overlayHost} draft={draft} clock={overlayClock} selection={['clip']} select={() => {}} /></div>
        }
        let activeRoot = createRoot(document.getElementById('root'))
        const show = Component => {
          activeRoot.unmount()
          activeRoot = createRoot(document.getElementById('root'))
          activeRoot.render(<LocaleProvider locale="en" setLocale={() => {}}><Component /></LocaleProvider>)
        }
        window.showOverlayFixture = () => { overlayPosition = 250.9; show(OverlayHarness) }
        window.showCropFixture = () => show(CropHarness)
        window.showAreaFixture = () => show(AreaHarness)
        window.showSaveFixture = () => { overlayPosition = 250.9; show(SaveHarness) }
        window.showLockFixture = () => show(LockHarness)
        window.showEmptyOverlayFixture = () => show(EmptyOverlayHarness)
        window.showTransformFixture = () => show(TransformHarness)
        window.showUnresolvedCropFixture = () => show(() => <TransformHarness unknown />)
        activeRoot.render(<LocaleProvider locale="en" setLocale={() => {}}><Harness /></LocaleProvider>)
      `, resolveDir: join(root, 'apps/web'), sourcefile: 'key-refusal-harness.tsx', loader: 'tsx' },
      bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'count-overlay-renders', setup(builder) {
        builder.onLoad({ filter: /OverlayLayer\.tsx$/ }, args => ({ loader: 'tsx', contents: readFileSync(args.path, 'utf8').replace(
          '  const [states, setStates]', '  window.overlayLayerRenders = (window.overlayLayerRenders ?? 0) + 1\n  const [states, setStates]').replace(
          '  const onRefused = useCallback((id: string, reason?: OverlayRefusal) => {', '  const onRefused = useCallback((id: string, reason?: OverlayRefusal) => {\n    if (reason === \'keyLimit\') window.overlayLimitReports = (window.overlayLimitReports ?? 0) + 1').replace(
          '  useEffect(() => {\n    // Only editing input', '  window.overlayRefusal = onRefused\n  useEffect(() => {\n    // Only editing input') }))
      } }],
    })
    script = result.outputFiles[0]!.text
    browser = await chromium.launch({ executablePath: chromePath(), headless: true })
  })
  beforeEach(async () => {
    page = await browser.newPage({ locale: 'en-US', viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 })
    errors.length = 0
    page.on('pageerror', error => errors.push(error.message))
    await page.route('http://localhost/key-refusals', route => route.fulfill({ contentType: 'text/html', body: `<style>* { box-sizing: border-box }${styles}</style><div id="root"></div>` }))
    await page.goto('http://localhost/key-refusals')
    await page.addScriptTag({ content: script })
  })
  afterEach(async ({ task }) => {
    if (task.result?.state === 'fail') {
      writeFileSync('/tmp/vis-step-c-review4-harness-failure.html', await page.content())
    }
    await page?.close()
    expect(errors).toEqual([])
  })
  afterAll(async () => { await browser?.close(); if (fixtureDir) removeTempDir(fixtureDir) })

  it.each([
    ['captions', 'Linked text would overlap other text or exceed the length limit. Turn off caption linkage to make this edit', '1'],
    ['invalid', 'Timeline limit reached', '0'],
    ['conflict', 'Conflict', '0'],
  ])('restores the diamond, selection and playhead on %s refusal', async (mode, message, calls) => {
    expect(await page.getByRole('button', { name: /^Key at / }).count()).toBe(3)
    const first = page.getByRole('button', { name: 'Key at 00:00.05: Crop', exact: true })
    const key = page.getByRole('button', { name: 'Key at 00:01.05: Crop', exact: true })
    expect(await key.getAttribute('title')).toBe('Key at 00:01.05: Crop')
    await first.click()
    await page.getByRole('button', { name: 'Seek outside clip', exact: true }).click()
    await page.evaluate(value => { (window as unknown as { refuseTransform(value: string): void }).refuseTransform(value) }, mode)
    await key.hover()
    const before = (await key.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + before.width / 2 + 30, before.y + before.height / 2, { steps: 5 })
    await page.mouse.up()
    await expect.poll(() => page.getByRole('alert').textContent()).toBe(message)
    await expect.poll(async () => (await key.boundingBox())!.x).toBeCloseTo(before.x, 2)
    expect(await first.getAttribute('aria-pressed')).toBe('true')
    expect(await key.getAttribute('aria-pressed')).toBe('false')
    expect(await page.getByRole('status', { name: 'Playhead', exact: true }).textContent()).toBe('200')
    expect(await page.getByRole('status', { name: 'Edit count', exact: true }).textContent()).toBe(calls)
  })

  it('keeps endpoint diamonds inside rounded clip bounds at fractional speeds and narrow widths', async () => {
    for (const [speed, outMs] of [[0.3, 5000], [1.01, 5000], [1.5, 5000], [4, 1008]]) {
      await page.evaluate(([speed, outMs]) => { (window as unknown as { setClipValues(speed: number, outMs: number): void }).setClipValues(speed!, outMs!) }, [speed!, outMs!])
      await expect.poll(() => page.getByRole('status', { name: 'Playback speed', exact: true }).textContent()).toBe(String(speed))
      const keys = page.getByRole('button', { name: /^Key at / })
      await expect.poll(async () => {
        const extent = (await page.getByRole('img', { name: 'Clip extent', exact: true }).boundingBox())!
        const first = (await keys.first().boundingBox())!
        const last = (await keys.last().boundingBox())!
        return first.x >= extent.x && last.x + last.width <= extent.x + extent.width + 0.001
      }).toBe(true)
      const outside = await keys.last().evaluate(element => {
        const button = element.getBoundingClientRect()
        const glyph = element.querySelector('svg')!.getBoundingClientRect()
        return glyph.left < button.left || glyph.right > button.right
      })
      expect(outside).toBe(false)
    }
  })


  it('permits an existing source-end key when rounded clip duration extends past source Out', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await expect.poll(() => overlay.isDisabled()).toBe(false)
    const before = await page.evaluate(() => (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { y: unknown } }[] }[] } }).overlayDocument().tracks[0]!.clips[0]!.overlay.y)
    await overlay.press('ArrowLeft')
    await expect.poll(() => page.evaluate(() => {
      const doc = (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { x: { keys: { t: number; value: number }[] } } }[] }[] } }).overlayDocument()
      return doc.tracks[0]!.clips[0]!.overlay.x.keys.find(key => key.t === 2002)?.value
    })).toBe(0.495)
    expect(await page.evaluate(() => (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { y: unknown } }[] }[] } }).overlayDocument().tracks[0]!.clips[0]!.overlay.y)).toEqual(before)
  })

  it.each(['captions', 'invalid', 'conflict'] as const)('shows overlay keyboard and pointer %s refusals and restores the document placement', async mode => {
    const message = mode === 'captions' ? 'Linked text would overlap other text or exceed the length limit. Turn off caption linkage to make this edit' : mode === 'invalid' ? 'Timeline limit reached' : 'Conflict'
    for (const pointer of [false, true]) {
      await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
      const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
      await overlay.waitFor()
      await expect.poll(() => overlay.isDisabled()).toBe(false)
      const before = await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())
      const bounds = (await overlay.boundingBox())!
      if (pointer) {
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
        await page.mouse.down()
        await page.mouse.move(bounds.x + bounds.width / 2 - 20, bounds.y + bounds.height / 2, { steps: 4 })
      }
      await overlay.evaluate((element, { mode, pointer }) => {
        element.addEventListener(pointer ? 'pointerup' : 'keydown', () => { (window as unknown as { refuseTransform(value: string): void }).refuseTransform(mode) }, { capture: true, once: true })
      }, { mode, pointer })
      if (pointer) await page.mouse.up()
      else await overlay.press('ArrowLeft')
      await expect.poll(() => page.getByRole('status').textContent()).toBe(message)
      expect(await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())).toEqual(before)
      await expect.poll(async () => (await overlay.boundingBox())!.x).toBeCloseTo(bounds.x, 2)
    }
  })

  it('explains a capped requested axis even when the other overlay axis can move', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    await page.getByRole('button', { name: 'Overlay Clamp source', exact: true }).waitFor()
    await page.evaluate(() => { (window as unknown as { showCappedAxis(): void }).showCappedAxis() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await expect.poll(() => overlay.isDisabled()).toBe(false)
    const before = await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())
    await overlay.press('ArrowRight')
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Maximum 32 keys per property; remove a key first')
    expect(await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())).toEqual(before)
    await overlay.press('ArrowDown')
    await expect.poll(() => page.evaluate(() => (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { y: number } }[] }[] } }).overlayDocument().tracks[0]!.clips[0]!.overlay.y)).toBe(0.155)
    expect(await page.getByRole('status').count()).toBe(0)
  })

  it.each([[0, 'ArrowLeft'], [1, 'ArrowRight']] as const)('explains a capped axis at the clamped %s edge', async (edge, key) => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await page.evaluate(edge => { (window as unknown as { showCappedAxis(x: number): void }).showCappedAxis(edge) }, edge)
    const before = await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())
    for (let i = 0; i < 2; i++) {
      await overlay.press(key)
      await expect.poll(() => page.getByRole('status').textContent()).toBe('Maximum 32 keys per property; remove a key first')
      expect(await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())).toEqual(before)
    }
  })

  it('holds a capped x axis in both preview and commit during a diagonal overlay drag', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await page.evaluate(() => { (window as unknown as { showCappedAxis(): void }).showCappedAxis() })
    const originalX = await page.evaluate(() => (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { x: unknown } }[] }[] } }).overlayDocument().tracks[0]!.clips[0]!.overlay.x)
    const bounds = (await overlay.boundingBox())!
    await page.keyboard.down('Alt')
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 32, bounds.y + bounds.height / 2 + 18, { steps: 8 })
    const preview = (await overlay.boundingBox())!
    expect(preview.x).toBeCloseTo(bounds.x, 2)
    expect(preview.y).toBeCloseTo(bounds.y + 18, 1)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(() => page.evaluate(() => (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { y: number } }[] }[] } }).overlayDocument().tracks[0]!.clips[0]!.overlay.y)).toBe(0.25)
    expect(await page.evaluate(() => (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { x: unknown } }[] }[] } }).overlayDocument().tracks[0]!.clips[0]!.overlay.x)).toEqual(originalX)
    expect((await overlay.boundingBox())!.y).toBeCloseTo(preview.y, 2)
  })

  it.each(['field', 'handle'] as const)('retains Free after a %s edit enters the square preset tolerance', async control => {
    await page.evaluate(() => { (window as unknown as { showTransformFixture(): void }).showTransformFixture() })
    const lock = page.getByRole('combobox', { name: 'Aspect lock', exact: true })
    await expect.poll(() => lock.isEnabled()).toBe(true)
    expect(await lock.inputValue()).toBe('free')
    if (control === 'field') {
      const width = page.getByRole('spinbutton', { name: 'Crop width', exact: true })
      await width.fill('44.8')
      await width.press('Enter')
    } else await page.getByRole('button', { name: 'Crop: Right edge', exact: true }).press('ArrowRight')
    const sample = () => page.evaluate(() => (window as unknown as { cropDocument(): { tracks: { clips: { crop: { width: number; height: number } }[] }[] } }).cropDocument().tracks[0]!.clips[0]!.crop)
    await expect.poll(sample).toMatchObject({ width: 0.448, height: 0.8 })
    expect(await lock.inputValue()).toBe('free')
    await page.getByRole('button', { name: 'Crop: Right edge', exact: true }).press('ArrowRight')
    await expect.poll(sample).toMatchObject({ width: 0.449, height: 0.8 })
    expect(await lock.inputValue()).toBe('free')
  })

  it.each(['handle', 'field'] as const)('does not store a lock after an unresolved-size crop %s edit', async control => {
    await page.evaluate(() => { (window as unknown as { showUnresolvedCropFixture(): void }).showUnresolvedCropFixture() })
    const lock = page.getByRole('combobox', { name: 'Aspect lock', exact: true })
    await lock.waitFor()
    expect(await lock.isDisabled()).toBe(true)
    expect(await lock.inputValue()).toBe('free')
    if (control === 'handle') await page.getByRole('button', { name: 'Crop: Right edge', exact: true }).press('ArrowRight')
    else {
      const width = page.getByRole('spinbutton', { name: 'Crop width', exact: true })
      await width.fill('80.1')
      await width.press('Enter')
    }
    await expect.poll(() => page.evaluate(() => (window as unknown as { cropDocument(): { tracks: { clips: { crop: unknown }[] }[] } }).cropDocument().tracks[0]!.clips[0]!.crop)).toMatchObject({ width: 0.801, height: 0.8 })
    await page.evaluate(() => { (window as unknown as { resolveCropInfo(): void }).resolveCropInfo() })
    await expect.poll(() => lock.isEnabled()).toBe(true)
    expect(await lock.inputValue()).toBe('output')
  })

  it('does not store an unknown-size pointerdown lock when metadata resolves before pointerup', async () => {
    await page.evaluate(() => { (window as unknown as { showUnresolvedCropFixture(): void }).showUnresolvedCropFixture() })
    const lock = page.getByRole('combobox', { name: 'Aspect lock', exact: true })
    const handle = page.getByRole('button', { name: 'Crop: Right edge', exact: true })
    await handle.hover()
    expect(await lock.isDisabled()).toBe(true)
    const bounds = (await handle.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 1, bounds.y + bounds.height / 2)
    await page.evaluate(() => { (window as unknown as { resolveCropInfo(): void }).resolveCropInfo() })
    await expect.poll(() => lock.isEnabled()).toBe(true)
    expect(await lock.inputValue()).toBe('output')
    await page.mouse.up()
    await expect.poll(() => page.evaluate(() => (window as unknown as { cropDocument(): { tracks: { clips: { crop: unknown }[] }[] } }).cropDocument().tracks[0]!.clips[0]!.crop)).toMatchObject({ width: 0.802, height: 0.8 })
    expect(await lock.inputValue()).toBe('output')
  })

  it.each(['add', 'remove', 'ease'] as const)('keeps the lock derived after a crop key %s action', async action => {
    await page.evaluate(() => { (window as unknown as { showTransformFixture(): void }).showTransformFixture() })
    const lock = page.getByRole('combobox', { name: 'Aspect lock', exact: true })
    await expect.poll(() => lock.isEnabled()).toBe(true)
    if (action !== 'add') {
      await page.evaluate(() => { (window as unknown as { writeTransformCrop(value: unknown): void }).writeTransformCrop({ keys: [1000, 2002].map(t => ({ t, value: { x: 0.1, y: 0.1, width: 0.447, height: 0.8 }, ease: 'linear' })) }) })
      await page.getByRole('button', { name: 'Crop keyframe: Key here (filled)', exact: true }).waitFor()
    }
    if (action === 'ease') await page.getByRole('combobox', { name: 'Crop key ease', exact: true }).selectOption('hold')
    else await page.getByRole('button', { name: action === 'add' ? 'Crop keyframe: Static (hollow)' : 'Crop keyframe: Key here (filled)', exact: true }).click()
    expect(await lock.inputValue()).toBe('free')
    await page.evaluate(() => { (window as unknown as { writeTransformCrop(value: unknown): void }).writeTransformCrop({ x: 0.1, y: 0.1, width: 0.6, height: 0.8 }) })
    await expect.poll(() => lock.inputValue()).toBe('4:3')
  })

  it('clears a chosen aspect lock on an accepted reset and derives the next crop lock', async () => {
    await page.evaluate(() => { (window as unknown as { showTransformFixture(): void }).showTransformFixture() })
    const lock = page.getByRole('combobox', { name: 'Aspect lock', exact: true })
    await expect.poll(() => lock.isEnabled()).toBe(true)
    await lock.selectOption('1:1')
    expect(await lock.inputValue()).toBe('1:1')
    await page.getByRole('button', { name: 'Reset transform', exact: true }).click()
    expect(await lock.inputValue()).toBe('output')
    expect(await page.evaluate(() => (window as unknown as { cropDocument(): { tracks: { clips: { crop?: unknown }[] }[] } }).cropDocument().tracks[0]!.clips[0]!.crop)).toBeUndefined()
    await page.evaluate(() => { (window as unknown as { writeTransformCrop(value: unknown): void }).writeTransformCrop({ x: 0.1, y: 0.1, width: 0.6, height: 0.8 }) })
    await expect.poll(() => lock.inputValue()).toBe('4:3')
  })

  it.each(['captions', 'invalid', 'conflict'] as const)('retains the previous aspect lock after a %s refit refusal', async reason => {
    await page.evaluate(() => { (window as unknown as { showTransformFixture(): void }).showTransformFixture() })
    const lock = page.getByRole('combobox', { name: 'Aspect lock', exact: true })
    await expect.poll(() => lock.isEnabled()).toBe(true)
    const before = await page.evaluate(() => (window as unknown as { cropDocument(): unknown }).cropDocument())
    await page.evaluate(reason => { (window as unknown as { refuseTransform(reason: string): void }).refuseTransform(reason) }, reason)
    await lock.selectOption('1:1')
    expect(await lock.inputValue()).toBe('free')
    expect(await page.evaluate(() => (window as unknown as { cropDocument(): unknown }).cropDocument())).toEqual(before)
    const message = reason === 'captions' ? 'Linked text would overlap' : reason === 'invalid' ? 'Timeline limit reached' : 'Conflict'
    await page.getByRole('status').filter({ hasText: message }).waitFor()
  })

  it.each(['captions', 'invalid', 'conflict'] as const)('keeps crop %s messages through playback paints until another crop action', async mode => {
    await page.evaluate(() => { (window as unknown as { showCropFixture(): void }).showCropFixture() })
    const handle = page.getByRole('button', { name: 'Crop: Move', exact: true })
    await handle.waitFor()
    const before = await page.evaluate(() => (window as unknown as { cropDocument(): unknown }).cropDocument())
    await page.evaluate(mode => { (window as unknown as { refuseTransform(value: string): void }).refuseTransform(mode) }, mode)
    await handle.dispatchEvent('keydown', { key: 'ArrowLeft' })
    const message = mode === 'captions' ? 'Linked text would overlap other text or exceed the length limit. Turn off caption linkage to make this edit' : mode === 'invalid' ? 'Timeline limit reached' : 'Conflict'
    await expect.poll(() => page.getByRole('status').textContent()).toBe(message)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))))
    expect(await page.getByRole('status').textContent()).toBe(message)
    expect(await page.evaluate(() => (window as unknown as { cropDocument(): unknown }).cropDocument())).toEqual(before)
    await page.evaluate(() => { (window as unknown as { refuseTransform(value: null): void }).refuseTransform(null) })
    await expect.poll(() => handle.isDisabled()).toBe(false)
    if (mode === 'conflict') await expect.poll(() => page.getByRole('status').textContent()).toBe('')
    await handle.press('ArrowLeft')
    await expect.poll(() => page.getByRole('status').textContent()).toBe('')
  })

  it('preserves an unrelated timeline notice after recovering from a key refusal', async () => {
    await page.evaluate(() => { (window as unknown as { showAreaFixture(): void }).showAreaFixture() })
    const key = page.getByRole('button', { name: 'Key at 00:01.05: Crop', exact: true })
    await key.waitFor()
    await page.evaluate(() => { (window as unknown as { refuseTransform(value: string): void }).refuseTransform('captions') })
    await key.press('ArrowRight')
    await page.getByRole('status').filter({ hasText: 'Linked text would overlap' }).waitFor()
    await page.evaluate(() => { (window as unknown as { refuseTransform(value: null): void }).refuseTransform(null) })
    await page.getByRole('group', { name: 'Overlay 1 lane', exact: true }).evaluate(element => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-vis-timeline-media', 'missing')
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }))
    })
    await page.getByRole('status').filter({ hasText: 'This media cannot be placed on this track' }).waitFor()
    await key.press('ArrowRight')
    await page.getByRole('button', { name: 'Key at 00:01.06: Crop', exact: true }).waitFor()
    expect(await page.getByRole('status').textContent()).toBe('This media cannot be placed on this track')
  })

  it.each(['selection', 'removed', 'content'] as const)('expires an overlay refusal after %s changes and restores the limited-preview status', async reason => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await page.evaluate(() => { (window as unknown as { showLimitedOverlays(): void }).showLimitedOverlays() })
    await expect.poll(() => page.evaluate(() => (window as unknown as { overlayPreviewState: { limited: boolean } }).overlayPreviewState.limited)).toBe(true)
    await page.evaluate(() => { (window as unknown as { refuseTransform(value: string): void }).refuseTransform('captions') })
    await overlay.press('ArrowLeft')
    await page.getByRole('status').filter({ hasText: 'Linked text would overlap' }).waitFor()
    expect(await page.getByRole('status').textContent()).toContain('Linked text would overlap')
    await page.evaluate(reason => { (window as unknown as { expireOverlayNotice(reason: string): void }).expireOverlayNotice(reason) }, reason)
    if (reason === 'removed') await expect.poll(() => page.getByRole('status').count()).toBe(0)
    else {
      await expect.poll(() => page.getByRole('status').textContent()).toBe('Preview limited · Export includes every overlay')
      if (reason === 'selection') {
        await page.evaluate(() => { (window as unknown as { restoreOverlaySelection(): void }).restoreOverlaySelection() })
        expect(await page.getByRole('status').textContent()).toBe('Preview limited · Export includes every overlay')
      }
    }
  })

  it('moves a small diagonal and preserves a two-pixel dominant-axis fine adjustment after gesture start', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    const sample = () => page.evaluate(() => {
      const doc = (window as unknown as { overlayDocument(): { tracks: { clips: { overlay: { x: { keys: { value: number }[] }; y: { keys: { value: number }[] } } }[] }[] } }).overlayDocument()
      const value = doc.tracks[0]!.clips[0]!.overlay
      return { x: value.x.keys.at(-1)!.value, y: value.y.keys.at(-1)!.value }
    })
    await page.keyboard.down('Alt')
    let bounds = (await overlay.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 2.5, bounds.y + bounds.height / 2 + 2.5)
    await page.mouse.up()
    await expect.poll(sample).toEqual({ x: 0.508, y: 0.164 })
    bounds = (await overlay.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 6, bounds.y + bounds.height / 2 + 1)
    await page.mouse.move(bounds.x + bounds.width / 2 + 2, bounds.y + bounds.height / 2 + 1)
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect.poll(sample).toEqual({ x: 0.514, y: 0.164 })
  })

  it('keeps a fresh refusal through an earlier nudge save acknowledgement and expires it on undo and redo', async () => {
    await page.evaluate(() => { (window as unknown as { showSaveFixture(): void }).showSaveFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await overlay.press('ArrowLeft')
    await expect.poll(() => page.getByRole('status', { name: 'Save state', exact: true }).textContent()).toBe('saving')
    await page.evaluate(() => { (window as unknown as { refuseTransform(value: string): void }).refuseTransform('captions') })
    await overlay.press('ArrowRight')
    const refusal = page.getByRole('status').filter({ hasText: 'Linked text would overlap' })
    await refusal.waitFor()
    await page.evaluate(() => { (window as unknown as { finishOverlaySave(): void }).finishOverlaySave() })
    await expect.poll(() => page.getByRole('status', { name: 'Saved revision', exact: true }).textContent()).toBe('2')
    await expect.poll(() => page.getByRole('status', { name: 'Save state', exact: true }).textContent()).toBe('saved')
    expect(await refusal.count()).toBe(1)
    await page.evaluate(() => { (window as unknown as { undoOverlay(): void }).undoOverlay() })
    await expect.poll(() => refusal.count()).toBe(0)
    await page.evaluate(() => { (window as unknown as { redoOverlay(): void }).redoOverlay() })
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await refusal.count()).toBe(0)
  })

  it.each(['ArrowRight', 'Meta+z', 'Meta+Shift+z', 'Control+z', 'Control+Shift+z', 'Control+y', 'restore'])('expires missing-clip feedback on %s while preserving assistive navigation', async action => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    const bounds = (await overlay.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2)
    await page.evaluate(() => { (window as unknown as { removeOverlayDuringGesture(): void }).removeOverlayDuringGesture() })
    await page.mouse.up()
    await expect.poll(() => page.getByRole('status').textContent()).toBe('The clip or track no longer exists')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await page.getByRole('status').textContent()).toBe('The clip or track no longer exists')
    for (const key of ['Shift', 'Tab', 'Control+Alt+ArrowRight', 'h']) {
      await page.keyboard.press(key)
      expect(await page.getByRole('status').textContent()).toBe('The clip or track no longer exists')
    }
    await page.evaluate(() => {
      const field = document.createElement('textarea')
      field.setAttribute('aria-label', 'Outside text')
      document.body.append(field)
      field.focus()
    })
    for (const key of ['Meta+z', 'Control+z', 'Control+Shift+z', 'Control+y', 'ArrowLeft', 'Backspace']) {
      await page.keyboard.press(key)
      expect(await page.getByRole('status').textContent()).toBe('The clip or track no longer exists')
    }
    await page.getByRole('textbox', { name: 'Outside text', exact: true }).evaluate(element => element.remove())
    if (action === 'restore') {
      await page.evaluate(() => { (window as unknown as { restoreMissingOverlay(): void }).restoreMissingOverlay() })
      await expect.poll(() => overlay.isVisible()).toBe(true)
    } else await page.keyboard.press(action)
    await expect.poll(() => page.getByRole('status').count()).toBe(0)
    if (action === 'restore') {
      await page.evaluate(() => { (window as unknown as { removeOverlayDuringGesture(): void }).removeOverlayDuringGesture() })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)))
      expect(await page.getByRole('status').count()).toBe(0)
    }
  })

  it('keeps a crop key-limit refusal tied to the gesture time while playback advances between keys', async () => {
    await page.evaluate(() => { (window as unknown as { showCropFixture(): void }).showCropFixture() })
    const move = page.getByRole('button', { name: 'Crop: Move', exact: true })
    await move.waitFor()
    await page.evaluate(() => { (window as unknown as { prepareCropGesture(): void }).prepareCropGesture() })
    await expect.poll(() => move.isDisabled()).toBe(false)
    const bounds = (await move.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2)
    await page.evaluate(() => { (window as unknown as { capCropDuringGesture(): void }).capCropDuringGesture() })
    const before = await page.evaluate(() => (window as unknown as { cropDocument(): unknown }).cropDocument())
    await page.mouse.up()
    const message = 'Maximum 32 keys per property; remove a key first'
    await expect.poll(() => page.getByRole('status').textContent()).toBe(message)
    await page.evaluate(() => { (window as unknown as { setCropPosition(value: number): void }).setCropPosition(200) })
    await expect.poll(() => move.isDisabled()).toBe(true)
    expect(await page.getByRole('status').textContent()).toBe(message)
    expect(await page.evaluate(() => (window as unknown as { cropDocument(): unknown }).cropDocument())).toEqual(before)
    await page.evaluate(() => { (window as unknown as { setCropPosition(value: number): void }).setCropPosition(250.9) })
    await expect.poll(() => move.isDisabled()).toBe(false)
    await expect.poll(() => page.getByRole('status').textContent()).toBe('')
  })

  it('derives current crop defaults and discards explicit choices when clip ids leave the document', async () => {
    await page.evaluate(() => { (window as unknown as { showLockFixture(): void }).showLockFixture() })
    const lock = page.getByRole('status', { name: 'Stored aspect', exact: true })
    await expect.poll(() => lock.textContent()).toBe('output')
    await page.getByRole('button', { name: 'Add crop externally', exact: true }).click()
    expect(await lock.textContent()).toBe('output')
    await page.getByRole('button', { name: 'Undo crop', exact: true }).click()
    await page.getByRole('button', { name: 'Add crop externally', exact: true }).click()
    expect(await lock.textContent()).toBe('output')
    await page.getByRole('button', { name: 'Write 4:3 crop', exact: true }).click()
    await expect.poll(() => lock.textContent()).toBe('4:3')
    await page.getByRole('button', { name: 'Undo crop', exact: true }).click()
    for (const choice of ['output', 'free']) {
      if (choice === 'free') await page.getByRole('button', { name: 'Choose Free', exact: true }).click()
      await expect.poll(() => lock.textContent()).toBe(choice)
      await page.getByRole('button', { name: 'Remove locked clip', exact: true }).click()
      await expect.poll(() => lock.textContent()).toBe('Removed')
      await page.getByRole('button', { name: 'Restore clip ID', exact: true }).click()
      await expect.poll(() => lock.textContent()).toBe('output')
    }
  })

  it('reports a corner resize refused by a new key limit at commit', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await page.evaluate(() => { (window as unknown as { prepareOverlayResize(): void }).prepareOverlayResize() })
    await overlay.hover()
    const bounds = (await overlay.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height - 1)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width + 20, bounds.y + bounds.height + 20)
    await page.evaluate(() => { (window as unknown as { capOverlayDuringGesture(): void }).capOverlayDuringGesture() })
    const before = await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())
    await page.mouse.up()
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Maximum 32 keys per property; remove a key first')
    expect(await page.evaluate(() => (window as unknown as { overlayDocument(): unknown }).overlayDocument())).toEqual(before)
  })

  it('selects a capped overlay without refusal and explains an attempted drag', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await page.evaluate(() => { (window as unknown as { capAllOverlayAxes(): void }).capAllOverlayAxes() })
    await overlay.click()
    expect(await overlay.getAttribute('aria-selected')).toBe('true')
    expect(await page.getByRole('status').count()).toBe(0)
    const bounds = (await overlay.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width / 2 + 20, bounds.y + bounds.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Maximum 32 keys per property; remove a key first')
    expect(await page.evaluate(() => (window as unknown as { overlayLimitReports: number }).overlayLimitReports)).toBe(1)
  })

  it('shows an immediate pointerup refusal through a callback captured before selecting a capped overlay', async () => {
    await page.evaluate(() => { (window as unknown as { showOverlayFixture(): void }).showOverlayFixture() })
    const overlay = page.getByRole('button', { name: 'Overlay Clamp source', exact: true })
    await overlay.waitFor()
    await page.evaluate(() => {
      const fixture = window as unknown as { capAllOverlayAxes(): void; unselectOverlay(): void }
      fixture.capAllOverlayAxes()
      fixture.unselectOverlay()
    })
    await expect.poll(() => overlay.getAttribute('aria-selected')).toBe('false')
    await overlay.evaluate(element => {
      const report = (window as unknown as { overlayRefusal(id: string, reason: string): void }).overlayRefusal
      element.addEventListener('pointerup', () => report('source-end', 'keyLimit'), { once: true })
    })
    const bounds = (await overlay.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.up()
    expect(await overlay.getAttribute('aria-selected')).toBe('true')
    await expect.poll(() => page.getByRole('status').textContent()).toBe('Maximum 32 keys per property; remove a key first')
  })

  it('renders an overlay content or selection transition once without layout-effect updates', async () => {
    await page.evaluate(() => { (window as unknown as { showEmptyOverlayFixture(): void }).showEmptyOverlayFixture() })
    const renders = () => page.evaluate(() => (window as unknown as { overlayLayerRenders: number }).overlayLayerRenders)
    await expect.poll(renders).toBeGreaterThan(0)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const before = await renders()
    await page.evaluate(() => { (window as unknown as { changeEmptyOverlayDoc(): void }).changeEmptyOverlayDoc() })
    expect(await renders()).toBe(before + 1)
    await page.evaluate(() => { (window as unknown as { changeEmptyOverlaySelection(): void }).changeEmptyOverlaySelection() })
    expect(await renders()).toBe(before + 2)
  })

})
