import { VisError } from '@vis/domain'
import { isMediaKind, type CanvasNodeKind, type CanvasOp, type NodePurpose } from '@vis/protocol'
import { and, inArray, isNull, spaceSchema as s, type SpaceTx } from '@vis/storage'

/** Author placement survives Agent turns, including mixed batches and frame moves. */
export function assertAgentLayout(tx: SpaceTx, ops: readonly CanvasOp[]): void {
  const protectedOps = ops.filter(op => op.op === 'frame.move' || (op.op === 'node.layout' && [op.x, op.y, op.w, op.h].some(value => value !== undefined)))
  const ids = [...new Set(protectedOps.map(op => 'nodeId' in op ? op.nodeId : ''))]
  const existing = new Set(ids.length ? tx.select({ id: s.nodes.id }).from(s.nodes).where(and(inArray(s.nodes.id, ids), isNull(s.nodes.deletedAt))).all().map(row => row.id) : [])
  const created = new Set<string>()
  for (const op of ops) {
    if (op.op === 'node.create' || op.op === 'frame.create') created.add(op.tempId)
    if (op.op !== 'frame.move' && !(op.op === 'node.layout' && [op.x, op.y, op.w, op.h].some(value => value !== undefined))) continue
    if (existing.has(op.nodeId) && !created.has(op.nodeId)) {
      throw VisError.of('forbidden', 'canvas.layout_protected', { nodeId: op.nodeId }, 'Agents cannot move or resize existing nodes. Use canvas.organize.propose for the author to review.')
    }
  }
}

/** Keep agent media visible; only the author may hide it as a working document. */
export function assertAgentMediaPurpose(tx: SpaceTx, ops: readonly CanvasOp[]): void {
  const ids = [...new Set(ops.flatMap(op => op.op === 'node.setMeta' && op.purpose !== undefined ? [op.nodeId] : []))]
  const rows = ids.length ? tx.select({ id: s.nodes.id, kind: s.nodes.kind, purpose: s.nodes.purpose }).from(s.nodes)
    .where(and(inArray(s.nodes.id, ids), isNull(s.nodes.deletedAt))).all() : []
  const nodes = new Map<string, { kind: CanvasNodeKind; purpose: NodePurpose }>(rows.map(node => [node.id, node]))
  const refuse = (params: { tempId: string } | { nodeId: string }) => {
    throw VisError.of('forbidden', 'canvas.working_media_forbidden', params, 'Agents cannot hide media as working documents. Leave purpose unset (artifact) for media.')
  }
  for (const op of ops) {
    if (op.op === 'frame.create') nodes.set(op.tempId, { kind: 'frame', purpose: 'artifact' })
    if (op.op === 'node.create') {
      if (op.purpose === 'working' && isMediaKind(op.kind)) refuse({ tempId: op.tempId })
      nodes.set(op.tempId, { kind: op.kind, purpose: op.purpose ?? 'artifact' })
    }
    if (op.op !== 'node.setMeta' || op.purpose === undefined) continue
    const node = nodes.get(op.nodeId)
    if (!node) continue
    if (op.purpose === 'working' && node.purpose !== 'working' && isMediaKind(node.kind)) refuse({ nodeId: op.nodeId })
    node.purpose = op.purpose
  }
}
