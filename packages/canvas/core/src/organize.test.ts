import { afterEach, beforeEach, expect, it } from 'vitest'
import { organizePlanDigest, planOrganize } from '@vis/canvas-layout'
import type { MethodParams, NodeView } from '@vis/protocol'
import { openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createCanvasService, type CanvasService } from './service'

let db: SpaceDb
let canvas: CanvasService
const user = { kind: 'user' } as const
const titles = { uncategorized: 'Uncategorized', untitledScript: 'Untitled script' }
beforeEach(() => { db = openSpaceDb(':memory:'); canvas = createCanvasService({ db, now: () => 1 }) })
afterEach(() => db.$client.close())
const preview = (extra: Partial<MethodParams<'canvas.organize'>> = {}) => {
  const params = { requestId: 'organize', mode: 'category' as const, columns: 'auto' as const, removeEmptyFrames: true, titles, description: 'Organize canvas', ...extra }
  return { ...params, planDigest: organizePlanDigest(planOrganize({ ...params, nodes: canvas.get({}).nodes })) }
}
const layout = (nodes: NodeView[]) => nodes.map(({ nodeId, x, y, w, h, frameId }) => ({ nodeId, x, y, w, h, frameId }))

it('organizes through the shared view builder, replays after later edits and keeps one undo entry', () => {
  canvas.apply(user, { requestId: 'create', ops: [
    { op: 'node.create', tempId: 'a', kind: 'image', x: 500, y: 500 },
    { op: 'node.create', tempId: 'b', kind: 'video', x: 0, y: 0 },
  ] })
  const before = layout(canvas.get({}).nodes)
  const params = preview()
  const result = canvas.organize(params)
  expect(result.changed).toBe(3)
  expect(Object.keys(result.idMap)).toHaveLength(1)
  const after = layout(canvas.get({}).nodes)
  const seq = readEventsAfter(db, 0).at(-1)!.seq
  expect(canvas.organize(params)).toEqual(result)
  expect(readEventsAfter(db, seq)).toEqual([])
  expect(canvas.undo({ requestId: 'undo' })).toMatchObject({ description: expect.stringContaining('Organize canvas') })
  expect(layout(canvas.get({}).nodes)).toEqual(before)
  canvas.redo({ requestId: 'redo' })
  expect(layout(canvas.get({}).nodes)).toEqual(after)
  expect(canvas.organize(params)).toEqual(result)
})

it('rejects empty plans, changed plans and oversized plans without writing events or history', () => {
  expect(() => canvas.organize(preview())).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'canvas.organize_nothing', params: {} } }))
  canvas.apply(user, { requestId: 'seed', ops: [{ op: 'node.create', tempId: 'a', kind: 'image' }] })
  const params = preview()
  canvas.apply(user, { requestId: 'category', ops: [{ op: 'node.setMeta', nodeId: canvas.get({}).nodes[0]!.nodeId, category: 'New' }] })
  const seq = readEventsAfter(db, 0).at(-1)!.seq
  expect(() => canvas.organize(params)).toThrow(expect.objectContaining({ code: 'revision_conflict', details: { reason: 'canvas.organize_plan_changed', params: {} } }))
  expect(readEventsAfter(db, seq)).toEqual([])
  db.transaction(tx => {
    for (let index = 0; index < 1000; index++) tx.insert(s.nodes).values({ id: `bulk-${index}`, kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 0, createdAt: 1 }).run()
  })
  expect(() => canvas.organize(preview({ requestId: 'large' }))).toThrow(expect.objectContaining({
    code: 'invalid_params', details: { reason: 'canvas.organize_too_large', params: { count: 1003, limit: 1000 } },
  }))
})

it('applies, undoes and redoes a 1000-node organize as one history step', () => {
  db.transaction(tx => {
    for (let index = 0; index < 999; index++) tx.insert(s.nodes).values({ id: `bulk-${index}`, kind: 'image', x: index, y: index, w: 320, h: 320, z: 0, createdAt: 1 }).run()
  })
  const before = layout(canvas.get({}).nodes)
  const result = canvas.organize(preview({ columns: 8 }))
  expect(result.changed).toBe(1000)
  expect(db.select().from(s.undoEntries).all()).toHaveLength(1)
  const after = layout(canvas.get({}).nodes)
  canvas.undo({ requestId: 'undo-large' })
  expect(layout(canvas.get({}).nodes)).toEqual(before)
  expect(canvas.undo({ requestId: 'undo-again' })).toEqual({ nothing: true })
  canvas.redo({ requestId: 'redo-large' })
  expect(layout(canvas.get({}).nodes)).toEqual(after)
  expect(planOrganize({ nodes: canvas.get({}).nodes, mode: 'category', columns: 8, removeEmptyFrames: true, titles }).ops).toEqual([])
}, 20_000)
