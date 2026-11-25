import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCanvasService } from '@vis/canvas-core'
import * as protocol from '@vis/protocol'
import { currentSeq, eq, openSpaceDb, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { assertAgentLayout, assertAgentMediaPurpose } from './canvas-permissions'

let db: SpaceDb
beforeEach(() => { db = openSpaceDb(':memory:') })
afterEach(() => { vi.restoreAllMocks(); db.$client.close() })

it('follows the protocol classifier when another canvas kind becomes media', () => {
  vi.spyOn(protocol, 'isMediaKind').mockImplementation((kind): kind is protocol.MediaKind => kind === 'future-media')
  const op = { op: 'node.create', tempId: 'future', kind: 'future-media', purpose: 'working' } as unknown as protocol.CanvasOp
  expect(() => db.transaction(tx => assertAgentMediaPurpose(tx, [op]))).toThrow(expect.objectContaining({
    code: 'forbidden', details: { reason: 'canvas.working_media_forbidden', params: { tempId: 'future' } },
  }))
})

it('reads existing node state once for a batch with many metadata operations', () => {
  const canvas = createCanvasService({ db })
  const created = canvas.apply({ kind: 'user' }, { requestId: 'seed', ops: [
    { op: 'node.create', tempId: 'text', kind: 'text' },
    { op: 'node.create', tempId: 'script', kind: 'script' },
    { op: 'node.create', tempId: 'timeline', kind: 'timeline' },
  ] })
  const ops: protocol.CanvasOp[] = Array.from({ length: 30 }, () => Object.values(created.idMap)
    .map(nodeId => ({ op: 'node.setMeta' as const, nodeId, purpose: 'working' as const }))).flat()
  db.transaction(tx => {
    const select = vi.spyOn(tx, 'select')
    assertAgentMediaPurpose(tx, ops)
    expect(select).toHaveBeenCalledTimes(1)
  })
})

function layoutFixture() {
  const canvas = createCanvasService({ db })
  db.insert(s.sessions).values({ id: 'agent', agentKind: 'codex', title: '', createdAt: 1 }).run()
  const created = canvas.apply({ kind: 'user' }, { requestId: 'seed', ops: [
    { op: 'frame.create', tempId: 'frame', title: 'Results', x: 0, y: 0, w: 800, h: 900 },
    { op: 'node.create', tempId: 'image', kind: 'image', x: 40, y: 60, w: 320, h: 180 },
    { op: 'node.create', tempId: 'below', kind: 'image', x: 40, y: 280, w: 320, h: 180 },
  ] })
  const apply = (ops: protocol.CanvasOp[], requestId: string = crypto.randomUUID()) => canvas.apply({ kind: 'agent', sessionId: 'agent' },
    { requestId, ops }, tx => assertAgentLayout(tx, ops))
  return { canvas, apply, image: created.idMap.image!, below: created.idMap.below!, frame: created.idMap.frame! }
}

it.each(['x', 'y', 'w', 'h'] as const)('atomically refuses existing node %s before any mixed-batch write, naming the first target', axis => {
  const { canvas, apply, image, below } = layoutFixture()
  const before = canvas.get({})
  const seq = currentSeq(db)
  const operations = db.select().from(s.operations).all()
  const requests = db.select().from(s.idempotencyKeys).all()
  expect(() => apply([
    { op: 'node.create', tempId: 'new', kind: 'text' },
    { op: 'node.setMeta', nodeId: image!, title: 'Must roll back' },
    { op: 'node.layout', nodeId: below!, [axis]: 200 },
    { op: 'node.layout', nodeId: image!, x: 600 },
  ])).toThrow(expect.objectContaining({ code: 'forbidden', details: { reason: 'canvas.layout_protected', params: { nodeId: below } } }))
  expect(canvas.get({})).toEqual(before)
  expect(currentSeq(db)).toBe(seq)
  expect(db.select().from(s.operations).all()).toEqual(operations)
  expect(db.select().from(s.idempotencyKeys).all()).toEqual(requests)
})

it('refuses existing frame moves, allows z alone and leaves user layout writes unrestricted', () => {
  const { canvas, apply, image, frame } = layoutFixture()
  expect(() => apply([{ op: 'frame.move', nodeId: frame!, dx: 0, dy: 0 }])).toThrow(expect.objectContaining({
    code: 'forbidden', details: { reason: 'canvas.layout_protected', params: { nodeId: frame } },
  }))
  apply([{ op: 'node.layout', nodeId: image!, z: 10 }])
  expect(canvas.get({ nodeIds: [image!] }).nodes[0]!.z).toBe(10)
  canvas.apply({ kind: 'user' }, { requestId: 'user-layout', ops: [
    { op: 'node.layout', nodeId: image!, x: 80, y: 100, w: 400, h: 220 },
    { op: 'frame.move', nodeId: frame!, dx: 100, dy: 100 },
  ] })
  expect(canvas.get({ nodeIds: [image!] }).nodes[0]).toMatchObject({ x: 180, y: 200, w: 400, h: 220 })
})

it('tracks creation tempIds in order for nodes and frames, including tempIds shadowing existing IDs', () => {
  const { canvas, apply, image } = layoutFixture()
  const params: protocol.CanvasOp[] = [
    { op: 'node.create', tempId: 'new', kind: 'image', x: 1200, y: 0 },
    { op: 'node.layout', nodeId: 'new', x: 1400, y: 100, w: 400, h: 240 },
    { op: 'frame.create', tempId: 'new-frame', title: 'Fresh', x: 1200, y: 0, w: 800, h: 800 },
    { op: 'frame.move', nodeId: 'new-frame', dx: 50, dy: 50 },
    { op: 'node.layout', nodeId: 'new-frame', w: 900 },
    { op: 'node.create', tempId: image!, kind: 'image' },
    { op: 'node.layout', nodeId: image!, w: 400 },
  ]
  const result = apply(params, 'create-layout')
  expect(canvas.get({ nodeIds: [result.idMap.new!] }).nodes[0]).toMatchObject({ x: 1450, y: 150, w: 400, h: 240 })
  expect(canvas.get({ nodeIds: [result.idMap['new-frame']!] }).nodes[0]).toMatchObject({ x: 1250, y: 50, w: 900 })
  expect(canvas.get({ nodeIds: [image!] }).nodes[0]!.w).toBe(320)
  expect(apply(params, 'create-layout')).toEqual(result)
  expect(() => apply([
    { op: 'node.layout', nodeId: image!, x: 500 },
    { op: 'node.create', tempId: image!, kind: 'image' },
  ])).toThrow(expect.objectContaining({ details: { reason: 'canvas.layout_protected', params: { nodeId: image } } }))
})

it('replays a successful request from before the layout rule without running new authorization', () => {
  const { canvas, apply, image } = layoutFixture()
  const ops: protocol.CanvasOp[] = [{ op: 'node.layout', nodeId: image!, x: 70 }]
  const result = canvas.apply({ kind: 'agent', sessionId: 'agent' }, { requestId: 'legacy-layout', ops })
  canvas.apply({ kind: 'user' }, { requestId: 'later-layout', ops: [{ op: 'node.layout', nodeId: image!, x: 110 }] })
  const seq = currentSeq(db)
  expect(apply(ops, 'legacy-layout')).toEqual(result)
  expect(currentSeq(db)).toBe(seq)
  expect(canvas.get({ nodeIds: [image!] }).nodes[0]!.x).toBe(110)
})

it('keeps creation placement, ancestor growth and media delivery push-down available to server mechanisms', () => {
  const { canvas, apply, image, below, frame } = layoutFixture()
  const placed = apply([{ op: 'node.create', tempId: 'placed', kind: 'image', x: 40, y: 60 }])
  expect(placed.placements?.placed).toBeDefined()
  const grown = apply([{ op: 'node.create', tempId: 'large', kind: 'image', category: 'Results', w: 1200, h: 1200 }])
  expect(canvas.get({ nodeIds: [grown.idMap.large!] }).nodes[0]!.frameId).toBe(frame)
  expect(canvas.get({ nodeIds: [frame!] }).nodes[0]!.w).toBeGreaterThan(800)
  db.insert(s.blobs).values({ hash: 'portrait', byteSize: 1, createdAt: 1 }).run()
  db.insert(s.assets).values({ id: 'asset', kind: 'image', origin: 'generation', createdAt: 1 }).run()
  db.insert(s.assetVersions).values({ id: 'portrait', assetId: 'asset', version: 1, blobHash: 'portrait', mime: 'image/png', width: 640, height: 960, createdAt: 1 }).run()
  const slot = canvas.get({ nodeIds: [image!] }).nodes[0]!.slots[0]!
  db.insert(s.generationJobs).values({ id: 'job', kind: 'image', provider: 'mock', model: 'mock', params: {}, status: 'finalizing', createdAt: 1, updatedAt: 1 }).run()
  db.insert(s.deliveryBindings).values({ id: 'binding', jobId: 'job', outputIndex: 0, targetKind: 'slot', nodeId: image!, slotId: slot.slotId, expectedContentRevision: slot.revision, status: 'pending' }).run()
  db.update(s.slots).set({ acceptedBindingId: 'binding' }).where(eq(s.slots.id, slot.slotId)).run()
  db.transaction(tx => canvas.deliverOutput(tx, { bindingId: 'binding', assetVersionId: 'portrait' }))
  expect(canvas.get({ nodeIds: [image!] }).nodes[0]!.h).toBe(480)
  expect(canvas.get({ nodeIds: [below!] }).nodes[0]!.y).toBeGreaterThan(280)
})
