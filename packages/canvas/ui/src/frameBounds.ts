import type { CanvasOp, NodeView } from '@vis/protocol'
import { frameMembers, frameMoveBatch, frameMoveOps, NODE_GAP } from './graph'

import { FRAME_PADDING, FRAME_HEADER, fitFrameBounds, growFrames } from '@vis/canvas-layout'
export { FRAME_PADDING, FRAME_HEADER, growFrames } from '@vis/canvas-layout'

type Move = { nodeId: string; x: number; y: number }

function ancestorGrowth(frame: NodeView, nodes: NodeView[]): CanvasOp[] {
  const ancestors = new Set<string>()
  let parentId = frame.frameId
  while (parentId && !ancestors.has(parentId)) {
    ancestors.add(parentId)
    parentId = nodes.find(node => node.nodeId === parentId)?.frameId
  }
  const prospective = nodes.filter(node => ancestors.has(node.nodeId) || (node.frameId && ancestors.has(node.frameId)))
  // Grow outer frames first: each layout immediately recomputes geometric membership on the server.
  return growFrames(prospective).filter(op => ancestors.has(op.nodeId)).reverse()
}

export function frameCreationOps(nodes: NodeView[], create: Extract<CanvasOp, { op: 'frame.create' }>, frameId: string | null): CanvasOp[] {
  const frame: NodeView = { nodeId: create.tempId, kind: 'frame', ...create, frameId, z: 0, layoutRevision: 0, slots: [] }
  return [...ancestorGrowth(frame, [...nodes, frame]), create]
}

export function fitFrameOps(frame: NodeView, nodes: NodeView[]): CanvasOp[] {
  const bounds = fitFrameBounds(frame, nodes)
  if (!bounds || (['x', 'y', 'w', 'h'] as const).every(key => frame[key] === bounds[key])) return []
  const prospective = nodes.map(node => node.nodeId === frame.nodeId ? { ...node, ...bounds } : node)
  return [...ancestorGrowth(frame, prospective), { op: 'node.layout', nodeId: frame.nodeId, ...bounds }]
}

export function constrainedMoves(nodes: NodeView[], moves: Move[], escape = false): Move[] {
  if (escape) return moves
  const moving = new Set(moves.map(move => move.nodeId))
  return moves.map(move => {
    const node = nodes.find(node => node.nodeId === move.nodeId)
    const frame = nodes.find(frame => frame.nodeId === node?.frameId)
    if (!node || !frame || moving.has(frame.nodeId)) return move
    return { ...move,
      x: Math.round(Math.max(frame.x + FRAME_PADDING, Math.min(move.x, frame.x + frame.w - node.w - FRAME_PADDING))),
      y: Math.round(Math.max(frame.y + FRAME_HEADER, Math.min(move.y, frame.y + frame.h - node.h - FRAME_PADDING))),
    }
  })
}

/** Translate recursively before refreshing geometric frame membership; the last step does not move members again. */
export function memberMoveOps(nodes: NodeView[], moves: Move[]): CanvasOp[] {
  const ops: CanvasOp[] = frameMoveOps(nodes, moves)
  for (const op of [...ops]) {
    if (op.op !== 'frame.move') continue
    const node = nodes.find(node => node.nodeId === op.nodeId)!
    ops.push({ op: 'node.layout', nodeId: op.nodeId, x: node.x + op.dx, y: node.y + op.dy })
  }
  return ops
}

export function leaveFrameOps(node: NodeView, nodes: NodeView[]): CanvasOp[] {
  const frame = nodes.find(frame => frame.nodeId === node.frameId)
  if (!frame) return []
  const descendants = new Set(frameMembers(node.nodeId, nodes).map(node => node.nodeId))
  const others = nodes.filter(other => other.nodeId !== node.nodeId && !descendants.has(other.nodeId))
  // Move to the right of all frames to avoid immediate reassignment caused by overlapping neighboring or ancestor frames.
  const x = Math.max(frame.x + frame.w, ...others.map(other => other.x + other.w)) + NODE_GAP
  return memberMoveOps(nodes, [{ nodeId: node.nodeId, x, y: node.y }])
}

export function movedFrameBounds(nodes: NodeView[], moves: Move[], escape = false) {
  return frameMoveBatch(nodes, constrainedMoves(nodes, moves, escape))
}
