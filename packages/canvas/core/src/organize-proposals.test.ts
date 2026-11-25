import { afterEach, beforeEach, expect, it } from 'vitest'
import { organizePlanDigest, planOrganize } from '@vis/canvas-layout'
import type { MethodParams } from '@vis/protocol'
import { currentSeq, eq, openSpaceDb, readEventsAfter, spaceSchema as s, type SpaceDb } from '@vis/storage'
import { createOrganizeProposalService } from './organize-proposals'
import { createCanvasService, type CanvasService } from './service'

let db: SpaceDb
let canvas: CanvasService
let service: ReturnType<typeof createOrganizeProposalService>
let clock: number
let request = 0
const rid = () => `proposal-${++request}`
const user = { kind: 'user' } as const
const titles = { uncategorized: 'Uncategorized', untitledScript: 'Script' }
beforeEach(() => {
  db = openSpaceDb(':memory:')
  clock = 1
  canvas = createCanvasService({ db, now: () => clock })
  service = createOrganizeProposalService({ db, now: () => clock })
  db.insert(s.sessions).values({ id: 'session', agentKind: 'codex', title: '', createdAt: clock }).run()
})
afterEach(() => db.$client.close())
const seed = () => canvas.apply(user, { requestId: rid(), ops: [
  { op: 'node.create', tempId: 'a', kind: 'image', x: 500, y: 500 },
  { op: 'node.create', tempId: 'b', kind: 'video', x: 0, y: 0 },
] })
const propose = (extra: Partial<MethodParams<'canvas.organize.propose'>> = {}, sessionId = 'session') =>
  service.propose(sessionId, { requestId: rid(), mode: 'category', columns: 'auto', reason: 'The finished results overlap.', ...extra })
const stored = (id: string) => service.list({ status: 'all' }).proposals.find(row => row.proposalId === id)!
const preview = (proposalId: string, extra: Partial<Extract<MethodParams<'canvas.organize.resolve'>, { action: 'apply' }>> = {}) => {
  const proposal = stored(proposalId)
  const params = { requestId: rid(), action: 'apply' as const, proposalId, removeEmptyFrames: true, titles, description: 'Organize finished results', ...extra }
  return { ...params, planDigest: organizePlanDigest(planOrganize({ nodes: canvas.get({}).nodes, ...proposal, ...params })) }
}
const events = (after = 0) => readEventsAfter(db, after, 10000).filter(row => row.type === 'canvas.organizeProposalChanged').map(row => row.payload)
const layout = () => canvas.get({}).nodes.map(({ nodeId, x, y, w, h, frameId }) => ({ nodeId, x, y, w, h, frameId }))

it('refuses empty, insufficient in-place and too-large plans before superseding or emitting events', () => {
  expect(() => propose()).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'canvas.organize_nothing', params: {} } }))
  const frame = canvas.apply(user, { requestId: rid(), ops: [{ op: 'frame.create', tempId: 'empty', title: 'Empty', x: 0, y: 0, w: 400, h: 300 }] }).idMap.empty!
  expect(() => propose({ mode: 'inPlace', nodeIds: [frame] })).toThrow(expect.objectContaining({ details: { reason: 'canvas.organize_nothing', params: {} } }))
  seed()
  const pending = propose()
  const seq = currentSeq(db)
  db.transaction(tx => {
    for (let index = 0; index < 1000; index++) tx.insert(s.nodes).values({ id: `bulk-${index}`, kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 0, createdAt: 1 }).run()
  })
  expect(() => propose()).toThrow(expect.objectContaining({ code: 'invalid_params', details: { reason: 'canvas.organize_too_large', params: { count: expect.any(Number), limit: 1000 } } }))
  expect(events(seq)).toEqual([])
  expect(stored(pending.proposalId)).toEqual(pending)
})

it('stores the neutral plan count, replays original results and supersedes only the same session', () => {
  seed()
  const before = layout()
  db.insert(s.sessions).values({ id: 'other', agentKind: 'codex', title: '', createdAt: clock }).run()
  const params: MethodParams<'canvas.organize.propose'> = { requestId: rid(), mode: 'category', columns: 'auto', reason: 'Separate finished results.' }
  const first = service.propose('session', params)
  const other = propose({}, 'other')
  clock++
  const next = propose()
  expect(first).toMatchObject({ changed: 3, status: 'pending', createdAt: 1 })
  expect(stored(first.proposalId)).toMatchObject({ status: 'superseded', resolvedAt: 2 })
  expect(service.list({ status: 'pending' }).proposals).toEqual([next, other])
  const seq = currentSeq(db)
  expect(service.propose('session', params, () => { throw new Error('Replay must not authorize again') })).toEqual(first)
  expect(currentSeq(db)).toBe(seq)
  expect(() => service.propose('other', params)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }))
  expect(events()).toEqual([
    { proposalId: first.proposalId, status: 'pending' },
    { proposalId: other.proposalId, status: 'pending' },
    { proposalId: first.proposalId, status: 'superseded' },
    { proposalId: next.proposalId, status: 'pending' },
  ])
  expect(layout()).toEqual(before)
})

it('expires the oldest pending proposal after superseding and orders equal timestamps deterministically', () => {
  seed()
  const proposals = Array.from({ length: 21 }, (_, index) => {
    const sessionId = `session-${index}`
    db.insert(s.sessions).values({ id: sessionId, agentKind: 'codex', title: '', createdAt: clock }).run()
    return propose({}, sessionId)
  })
  expect(service.list({ status: 'pending' }).proposals).toEqual(proposals.slice(1).reverse())
  expect(stored(proposals[0]!.proposalId)).toMatchObject({ status: 'expired', resolvedAt: clock })
  expect(events().at(-1)).toEqual({ proposalId: proposals[0]!.proposalId, status: 'expired' })
  const replaced = propose({}, 'session-1')
  expect(service.list({ status: 'pending' }).proposals).toHaveLength(20)
  expect(stored(proposals[1]!.proposalId).status).toBe('superseded')
  expect(stored(proposals[2]!.proposalId).status).toBe('pending')
  expect(service.list({ status: 'all' }).proposals[0]).toEqual(replaced)
})

it('dismisses and replays once, refuses closed or missing proposals and rolls back authorization failures', () => {
  seed()
  const proposal = propose()
  const before = layout()
  const params = { requestId: rid(), proposalId: proposal.proposalId, action: 'dismiss' as const }
  const seq = currentSeq(db)
  const result = service.resolve(params)
  expect(result).toMatchObject({ proposal: { ...proposal, status: 'dismissed', resolvedAt: clock } })
  expect(result).not.toHaveProperty('operationId')
  expect(service.resolve(params)).toEqual(result)
  expect(events(seq)).toEqual([{ proposalId: proposal.proposalId, status: 'dismissed' }])
  expect(() => service.resolve({ ...params, requestId: rid() })).toThrow(expect.objectContaining({ code: 'already_resolved', details: { reason: 'canvas.organize_proposal_closed', params: {} } }))
  expect(() => service.resolve({ ...params, requestId: rid(), proposalId: 'missing' })).toThrow(expect.objectContaining({ code: 'not_found' }))
  expect(() => service.propose('session', { requestId: rid(), mode: 'category', columns: 'auto', reason: 'Tidy.' }, () => { throw new Error('Inactive session') })).toThrow('Inactive session')
  expect(service.list({ status: 'all' }).proposals).toHaveLength(1)
  expect(layout()).toEqual(before)
})

it('applies the current localized preview as one user undo step and replays without any new write', () => {
  const created = seed()
  const proposal = propose()
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: created.idMap.a!, category: 'New category' }] })
  const before = layout()
  const undoCount = db.select().from(s.undoEntries).all().length
  const result = service.resolve(preview(proposal.proposalId, { titles: { uncategorized: 'Other results', untitledScript: 'Untitled script' } }))
  expect(result).toMatchObject({ operationId: expect.any(String), changed: expect.any(Number), proposal: { status: 'applied', operationId: result.operationId, resolvedAt: clock } })
  expect(result.eventSeq).toBe(currentSeq(db))
  expect(db.select().from(s.operations).where(eq(s.operations.id, result.operationId!)).get()).toMatchObject({ actorKind: 'user', actorSessionId: null, description: 'Organize finished results' })
  expect(db.select().from(s.undoEntries).all()).toHaveLength(undoCount + 1)
  expect(canvas.get({}).nodes.some(node => node.frame?.title === 'Other results')).toBe(true)
  expect(events().at(-1)).toEqual({ proposalId: proposal.proposalId, status: 'applied' })
  canvas.undo({ requestId: rid() })
  expect(layout()).toEqual(before)
  expect(stored(proposal.proposalId).status).toBe('applied')
  const second = propose()
  const params = preview(second.proposalId)
  const accepted = service.resolve(params)
  const seq = currentSeq(db)
  canvas.undo({ requestId: rid() })
  const undoneSeq = currentSeq(db)
  expect(service.resolve(params)).toEqual(accepted)
  expect(currentSeq(db)).toBe(undoneSeq)
  expect(undoneSeq).toBeGreaterThan(seq)
})

it('keeps a changed preview pending without events and lets the same request succeed after replanning', () => {
  const created = seed()
  const proposal = propose()
  const params = preview(proposal.proposalId)
  canvas.apply(user, { requestId: rid(), ops: [{ op: 'node.setMeta', nodeId: created.idMap.a!, category: 'Changed' }] })
  const seq = currentSeq(db)
  const before = layout()
  expect(() => service.resolve(params)).toThrow(expect.objectContaining({ code: 'revision_conflict', details: { reason: 'canvas.organize_plan_changed', params: {} } }))
  expect(stored(proposal.proposalId)).toEqual(proposal)
  expect(currentSeq(db)).toBe(seq)
  expect(layout()).toEqual(before)
  expect(service.resolve(preview(proposal.proposalId, { requestId: params.requestId })).proposal.status).toBe('applied')
})

it('marks an emptied plan stale without an operation and replays the result', () => {
  seed()
  const proposal = propose()
  const params = preview(proposal.proposalId)
  canvas.organize({ ...params, ...proposal, requestId: rid() })
  const seq = currentSeq(db)
  const operations = db.select().from(s.operations).all()
  const result = service.resolve(params)
  expect(result).toMatchObject({ proposal: { status: 'stale', resolvedAt: clock } })
  expect(result).not.toHaveProperty('operationId')
  expect(result).not.toHaveProperty('changed')
  expect(service.resolve(params)).toEqual(result)
  expect(db.select().from(s.operations).all()).toEqual(operations)
  expect(events(seq)).toEqual([{ proposalId: proposal.proposalId, status: 'stale' }])
  expect(() => service.resolve({ ...params, requestId: rid() })).toThrow(expect.objectContaining({ code: 'already_resolved' }))
})

it('bounds all-history reads to the newest 200 proposals and retains archived sessions like scene proposals', () => {
  seed()
  let last
  for (let index = 0; index < 202; index++) last = propose()
  db.update(s.sessions).set({ archivedAt: ++clock }).where(eq(s.sessions.id, 'session')).run()
  expect(service.list({ status: 'pending' }).proposals).toEqual([last])
  expect(service.list({ status: 'all' }).proposals).toHaveLength(200)
  expect(service.list({ status: 'all' }).proposals[0]).toEqual(last)
})
