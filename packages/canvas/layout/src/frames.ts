import type { CanvasOp, NodeView } from '@vis/protocol'

export const NODE_GAP = 80
export const FRAME_MIN_SIZE = { w: 320, h: 200 }
export const FRAME_PADDING = 24
export const FRAME_HEADER = 56

export type FrameBounds = { x: number; y: number; w: number; h: number }

export function frameContentBounds(members: NodeView[]): FrameBounds | null {
  if (!members.length) return null
  const x = Math.min(...members.map(node => node.x)) - FRAME_PADDING
  const y = Math.min(...members.map(node => node.y)) - FRAME_HEADER
  return {
    x, y,
    w: Math.max(FRAME_MIN_SIZE.w, Math.max(...members.map(node => node.x + node.w)) + FRAME_PADDING - x),
    h: Math.max(FRAME_MIN_SIZE.h, Math.max(...members.map(node => node.y + node.h)) + FRAME_PADDING - y),
  }
}

export function frameSelectionBounds(selection: NodeView[]): { bounds: FrameBounds; frameId: string | null } | { error: 'cross-frame' } | null {
  const members = selection.filter(node => node.kind !== 'frame')
  const bounds = frameContentBounds(members)
  if (!bounds) return null
  const frameIds = new Set(members.map(node => node.frameId ?? null))
  if (frameIds.size > 1) return { error: 'cross-frame' }
  return { bounds, frameId: members[0]!.frameId ?? null }
}

export function fitFrameBounds(frame: NodeView, nodes: NodeView[]): FrameBounds | null {
  // Include nested frames themselves, rather than flattening their descendants into the parent's padding.
  return frameContentBounds(frameMembers(frame.nodeId, nodes).filter(node => node.frameId === frame.nodeId))
}

/** Server membership is the sole authority; cycles or duplicate memberships still move each node only once. */
export function frameMembers(frameId: string, nodes: NodeView[]): NodeView[] {
  const ids = new Set([frameId])
  const members: NodeView[] = []
  for (const id of ids) {
    for (const node of nodes) {
      if (node.frameId !== id || ids.has(node.nodeId)) continue
      ids.add(node.nodeId)
      members.push(node)
    }
  }
  return members
}

/** No persisted manual-size marker exists, so conservatively retain all existing dimensions and only expand outward. */
export function growFrames(nodes: NodeView[]): Extract<CanvasOp, { op: 'node.layout' }>[] {
  const updated = nodes.map(node => ({ ...node }))
  const frames = updated.filter(node => node.kind === 'frame').sort((a, b) => frameMembers(a.nodeId, updated).length - frameMembers(b.nodeId, updated).length)
  const ops: Extract<CanvasOp, { op: 'node.layout' }>[] = []
  for (const frame of frames) {
    const members = updated.filter(node => node.frameId === frame.nodeId)
    const x = Math.min(frame.x, ...members.map(node => node.x - FRAME_PADDING))
    const y = Math.min(frame.y, ...members.map(node => node.y - FRAME_HEADER))
    const w = Math.max(FRAME_MIN_SIZE.w, frame.x + frame.w - x, ...members.map(node => node.x + node.w + FRAME_PADDING - x))
    const h = Math.max(FRAME_MIN_SIZE.h, frame.y + frame.h - y, ...members.map(node => node.y + node.h + FRAME_PADDING - y))
    if (x === frame.x && y === frame.y && w === frame.w && h === frame.h) continue
    Object.assign(frame, { x, y, w, h })
    ops.push({ op: 'node.layout', nodeId: frame.nodeId, x, y, w, h })
  }
  return ops
}
