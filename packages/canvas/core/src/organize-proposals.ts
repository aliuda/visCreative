import { organizeChangedCount, planOrganize } from '@vis/canvas-layout'
import { ulid, VisError } from '@vis/domain'
import { ORGANIZE_PROPOSAL_LIMITS, type MethodParams, type MethodResult, type OrganizeProposal, type OrganizeProposalStatus } from '@vis/protocol'
import { and, appendEvent, asc, desc, eq, runIdempotent, sql, spaceSchema as s, type SpaceDb, type SpaceTx } from '@vis/storage'
import { applyOrganize, assertOrganizePlan } from './organize'
import { readNodes } from './views'

type Row = typeof s.organizeProposals.$inferSelect
// ULIDs have random suffixes within a millisecond; SQLite insertion order breaks timestamp ties.
const insertionOrder = sql`${s.organizeProposals}.rowid`
function view(row: Row): OrganizeProposal {
  return { proposalId: row.id, sessionId: row.sessionId, mode: row.mode, columns: row.columns, reason: row.reason,
    changed: row.changed, status: row.status, createdAt: row.createdAt,
    ...(row.nodeIds === null ? {} : { nodeIds: row.nodeIds }),
    ...(row.resolvedAt === null ? {} : { resolvedAt: row.resolvedAt }),
    ...(row.operationId === null ? {} : { operationId: row.operationId }) }
}

function changed(tx: SpaceTx, row: Row, at: number) {
  return appendEvent(tx, { type: 'canvas.organizeProposalChanged', entityType: 'organizeProposal', entityId: row.id,
    payload: { proposalId: row.id, status: row.status }, ...(row.operationId ? { operationId: row.operationId } : {}) }, at)
}

function close(tx: SpaceTx, row: Row, status: OrganizeProposalStatus, at: number, operationId: string | null = null) {
  const updated = { ...row, status, resolvedAt: at, operationId }
  tx.update(s.organizeProposals).set({ status, resolvedAt: at, operationId }).where(eq(s.organizeProposals.id, row.id)).run()
  const eventSeq = changed(tx, updated, at)
  return { proposal: view(updated), eventSeq }
}

export function createOrganizeProposalService(deps: { db: SpaceDb; now?: () => number; onChanged?: (tx: SpaceTx) => void }) {
  const { db } = deps
  const now = deps.now ?? Date.now
  return {
    propose(sessionId: string, params: MethodParams<'canvas.organize.propose'>, authorize?: (tx: SpaceTx) => void): OrganizeProposal {
      return runIdempotent(db, { requestId: params.requestId, method: 'canvas.organize.propose', params: { ...params, sessionId } }, tx => {
        authorize?.(tx)
        const at = now()
        const plan = planOrganize({ ...params, nodes: readNodes(tx), removeEmptyFrames: true, titles: { uncategorized: 'Uncategorized', untitledScript: 'Script' } })
        assertOrganizePlan(plan)
        for (const row of tx.select().from(s.organizeProposals).where(and(eq(s.organizeProposals.sessionId, sessionId), eq(s.organizeProposals.status, 'pending'))).all()) {
          close(tx, row, 'superseded', at)
        }
        const row: Row = { id: `organizeProposal_${ulid(at)}`, sessionId, mode: params.mode, nodeIds: params.nodeIds ?? null,
          columns: params.columns, reason: params.reason, changed: organizeChangedCount(plan), status: 'pending', createdAt: at, resolvedAt: null, operationId: null }
        tx.insert(s.organizeProposals).values(row).run()
        changed(tx, row, at)
        const pending = tx.select().from(s.organizeProposals).where(eq(s.organizeProposals.status, 'pending')).orderBy(asc(s.organizeProposals.createdAt), asc(insertionOrder)).all()
        for (const oldest of pending.slice(0, Math.max(0, pending.length - ORGANIZE_PROPOSAL_LIMITS.pending))) close(tx, oldest, 'expired', at)
        return view(row)
      }, now)
    },
    list(params: MethodParams<'canvas.organize.proposals'>): MethodResult<'canvas.organize.proposals'> {
      // Keep review history bounded to the newest 200 proposals; pending is independently bounded to 20.
      return { proposals: db.select().from(s.organizeProposals).where(params.status === 'all' ? undefined : eq(s.organizeProposals.status, 'pending'))
        .orderBy(desc(s.organizeProposals.createdAt), desc(insertionOrder)).limit(200).all().map(view) }
    },
    resolve(params: MethodParams<'canvas.organize.resolve'>): MethodResult<'canvas.organize.resolve'> {
      return runIdempotent(db, { requestId: params.requestId, method: 'canvas.organize.resolve', params }, tx => {
        const row = tx.select().from(s.organizeProposals).where(eq(s.organizeProposals.id, params.proposalId)).get()
        if (!row) throw new VisError('not_found', 'The organize proposal does not exist')
        if (row.status !== 'pending') throw VisError.of('already_resolved', 'canvas.organize_proposal_closed', {}, 'The organize proposal is no longer pending')
        const at = now()
        if (params.action === 'dismiss') return close(tx, row, 'dismissed', at)
        const plan = planOrganize({ nodes: readNodes(tx), mode: row.mode, columns: row.columns, nodeIds: row.nodeIds ?? undefined,
          removeEmptyFrames: params.removeEmptyFrames, titles: params.titles })
        if (plan.insufficientSelection || !plan.ops.length) return close(tx, row, 'stale', at)
        const result = applyOrganize(tx, params, plan, at)
        deps.onChanged?.(tx)
        const resolved = close(tx, row, 'applied', at, result.operationId)
        return { ...resolved, operationId: result.operationId, changed: result.changed }
      }, now)
    },
  }
}
