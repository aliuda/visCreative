import type { NodeView } from '@vis/protocol'

export type LayoutRect = { x: number; y: number; w: number; h: number }
export type LayoutNode = LayoutRect & { nodeId: string }
export type LayoutTarget = { nodeId: string; x: number; y: number }
export type Align = 'alignLeft' | 'alignCenter' | 'alignRight' | 'alignTop' | 'alignMiddle' | 'alignBottom'
export type SnapCandidates = { x: readonly number[]; y: readonly number[] }
export type SnapLines = { x?: number; y?: number }

export function selectionBounds(nodes: readonly LayoutRect[]): LayoutRect | null {
  if (!nodes.length) return null
  const x = Math.min(...nodes.map(node => node.x))
  const y = Math.min(...nodes.map(node => node.y))
  return { x, y, w: Math.max(...nodes.map(node => node.x + node.w)) - x, h: Math.max(...nodes.map(node => node.y + node.h)) - y }
}

export function alignTargets(nodes: readonly LayoutNode[], align: Align): LayoutTarget[] {
  const bounds = selectionBounds(nodes)
  if (!bounds) return []
  return nodes.map(node => ({
    nodeId: node.nodeId,
    x: Math.round(align === 'alignLeft' ? bounds.x : align === 'alignCenter' ? bounds.x + (bounds.w - node.w) / 2 : align === 'alignRight' ? bounds.x + bounds.w - node.w : node.x),
    y: Math.round(align === 'alignTop' ? bounds.y : align === 'alignMiddle' ? bounds.y + (bounds.h - node.h) / 2 : align === 'alignBottom' ? bounds.y + bounds.h - node.h : node.y),
  }))
}

export function distributeTargets(nodes: readonly LayoutNode[], axis: 'x' | 'y'): LayoutTarget[] {
  if (nodes.length < 3) return []
  const sorted = [...nodes].sort((a, b) => a[axis] - b[axis] || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  const first = sorted[0]!
  const last = sorted.at(-1)!
  const size = axis === 'x' ? 'w' : 'h'
  const totalGap = last[axis] - first[axis] - sorted.slice(0, -1).reduce((sum, node) => sum + node[size], 0)
  let position = first[axis]
  return sorted.map((node, index) => {
    // Negative gaps would preserve overlap unevenly, so overlapping selections use equal leading-edge spacing.
    const target = totalGap < 0 ? first[axis] + (last[axis] - first[axis]) * index / (sorted.length - 1) : position
    position += node[size] + totalGap / (sorted.length - 1)
    return { nodeId: node.nodeId, x: Math.round(node.x), y: Math.round(node.y), [axis]: Math.round(index === sorted.length - 1 ? last[axis] : target) }
  })
}

const lines = (position: number, size: number) => [position, position + size / 2, position + size]

/** Index only the current viewport once per drag, including recursive frame-member exclusions. */
export function buildSnapCandidates(nodes: readonly NodeView[], draggedIds: readonly string[], viewport: LayoutRect, visibleIds?: ReadonlySet<string>): SnapCandidates {
  const members = new Map<string, string[]>()
  for (const node of nodes) {
    if (!node.frameId) continue
    const list = members.get(node.frameId) ?? []
    list.push(node.nodeId)
    members.set(node.frameId, list)
  }
  const excluded = new Set(draggedIds)
  const queue = [...draggedIds]
  for (let index = 0; index < queue.length; index++) {
    for (const id of members.get(queue[index]!) ?? []) {
      if (excluded.has(id)) continue
      excluded.add(id)
      queue.push(id)
    }
  }
  const x = new Set<number>()
  const y = new Set<number>()
  for (const node of nodes) {
    if (excluded.has(node.nodeId) || (visibleIds ? !visibleIds.has(node.nodeId) : node.purpose === 'working')) continue
    if (node.x + node.w < viewport.x || node.y + node.h < viewport.y || node.x > viewport.x + viewport.w || node.y > viewport.y + viewport.h) continue
    for (const line of lines(node.x, node.w)) x.add(line)
    for (const line of lines(node.y, node.h)) y.add(line)
  }
  return { x: [...x].sort((a, b) => a - b), y: [...y].sort((a, b) => a - b) }
}

function closestSnap(moving: number[], candidates: readonly number[], threshold: number) {
  let best: { delta: number; line: number } | undefined
  for (const value of moving) {
    let low = 0
    let high = candidates.length
    while (low < high) {
      const mid = (low + high) >>> 1
      if (candidates[mid]! < value) low = mid + 1
      else high = mid
    }
    for (const index of [low - 1, low]) {
      const line = candidates[index]
      if (line === undefined) continue
      const delta = line - value
      if (Math.abs(delta) <= threshold && (!best || Math.abs(delta) < Math.abs(best.delta))) best = { delta, line }
    }
  }
  return best
}

/** Three binary searches per axis avoid scanning indexed cards on pointer moves. */
export function querySnap(bounds: LayoutRect, candidates: SnapCandidates, zoom: number, screenThreshold = 6): { dx: number; dy: number; guides: SnapLines } {
  const threshold = screenThreshold / Math.max(zoom, 0.001)
  const x = closestSnap(lines(bounds.x, bounds.w), candidates.x, threshold)
  const y = closestSnap(lines(bounds.y, bounds.h), candidates.y, threshold)
  return { dx: x?.delta ?? 0, dy: y?.delta ?? 0, guides: { ...(x ? { x: x.line } : {}), ...(y ? { y: y.line } : {}) } }
}

/** A frame clamp can undo a snap; only display lines that the resulting group still touches. */
export function matchingSnapLines(bounds: LayoutRect, guides: SnapLines): SnapLines {
  return {
    ...(guides.x !== undefined && lines(bounds.x, bounds.w).some(value => Math.abs(value - guides.x!) < 0.01) ? { x: guides.x } : {}),
    ...(guides.y !== undefined && lines(bounds.y, bounds.h).some(value => Math.abs(value - guides.y!) < 0.01) ? { y: guides.y } : {}),
  }
}
