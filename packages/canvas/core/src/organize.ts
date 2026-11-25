import { organizeChangedCount, organizePlanDigest, type OrganizePlan } from '@vis/canvas-layout'
import { VisError } from '@vis/domain'
import type { MethodParams } from '@vis/protocol'
import type { SpaceTx } from '@vis/storage'
import { applyOps } from './apply'

export function assertOrganizePlan(plan: OrganizePlan): void {
  if (plan.insufficientSelection || !plan.ops.length) throw VisError.of('invalid_params', 'canvas.organize_nothing', {}, 'There is nothing to organize')
  if (plan.tooLarge) throw VisError.of('invalid_params', 'canvas.organize_too_large', plan.tooLarge, 'The organize plan exceeds the node limit')
}

/** Both direct Organize and accepted proposals are author writes with the same preview and undo guarantees. */
export function applyOrganize(tx: SpaceTx, params: Pick<MethodParams<'canvas.organize'>, 'requestId' | 'description' | 'planDigest'>, plan: OrganizePlan, at: number) {
  assertOrganizePlan(plan)
  if (organizePlanDigest(plan) !== params.planDigest) throw VisError.of('revision_conflict', 'canvas.organize_plan_changed', {}, 'The canvas changed after the preview')
  // The planner bounds affected nodes; the public canvas.apply schema still caps untrusted batches at 200 ops.
  const { operationId, idMap, eventSeq } = applyOps(tx, { kind: 'user' }, { requestId: params.requestId, description: params.description, ops: plan.ops }, at)
  return { operationId, idMap, eventSeq, changed: organizeChangedCount(plan) }
}
