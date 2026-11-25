import { describe, expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { constrainedMoves, memberMoveOps, movedFrameBounds } from './frameBounds'
import { alignTargets, buildSnapCandidates, distributeTargets, matchingSnapLines, querySnap, selectionBounds } from './selectionLayout'

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({
  nodeId, kind: 'text', x: 0, y: 0, w: 100, h: 80, z: 0, layoutRevision: 0, slots: [], ...extra,
})
const items = [node('a', { x: 10, y: 20 }), node('b', { x: 210, y: 180, w: 60, h: 40 }), node('c', { x: 90, y: 100, w: 120, h: 60 })]

describe('Selection layout', () => {
  it.each([
    ['alignLeft', [[10, 20], [10, 180], [10, 100]]],
    ['alignCenter', [[90, 20], [110, 180], [80, 100]]],
    ['alignRight', [[170, 20], [210, 180], [150, 100]]],
    ['alignTop', [[10, 20], [210, 20], [90, 20]]],
    ['alignMiddle', [[10, 80], [210, 100], [90, 90]]],
    ['alignBottom', [[10, 140], [210, 180], [90, 160]]],
  ] as const)('aligns %s to the selection bounds without changing dimensions', (align, positions) => {
    expect(alignTargets(items, align).map(({ x, y }) => [x, y])).toEqual(positions)
    expect(items[0]).toMatchObject({ x: 10, y: 20, w: 100, h: 80 })
  })

  it('rounds positions and handles empty selections', () => {
    expect(alignTargets([node('a'), node('b', { x: 101, w: 10 })], 'alignCenter')[0]!.x).toBe(6)
    expect(alignTargets([], 'alignLeft')).toEqual([])
    expect(selectionBounds([])).toBeNull()
    expect(distributeTargets(items.slice(0, 2), 'x')).toEqual([])
  })

  it('distributes uneven horizontal and vertical gaps while keeping both endpoints', () => {
    const horizontal = [node('a'), node('b', { x: 140, w: 60 }), node('c', { x: 500, w: 120 })]
    expect(distributeTargets(horizontal, 'x')).toEqual([
      { nodeId: 'a', x: 0, y: 0 }, { nodeId: 'b', x: 270, y: 0 }, { nodeId: 'c', x: 500, y: 0 },
    ])
    const vertical = [node('a'), node('b', { y: 90, h: 40 }), node('c', { y: 400 })]
    expect(distributeTargets(vertical, 'y').map(target => target.y)).toEqual([0, 220, 400])
  })

  it('breaks leading-edge ties by node ID independently of input order', () => {
    const tied = [node('b', { w: 40 }), node('a', { w: 60 }), node('c', { x: 400 })]
    expect(distributeTargets(tied, 'x')).toEqual([
      { nodeId: 'a', x: 0, y: 0 }, { nodeId: 'b', x: 210, y: 0 }, { nodeId: 'c', x: 400, y: 0 },
    ])
  })

  it('uses equal leading-edge spacing when the total gap is negative', () => {
    const overlapping = [node('a', { w: 300 }), node('b', { x: 20, w: 40 }), node('c', { x: 100 })]
    expect(distributeTargets(overlapping, 'x').map(target => target.x)).toEqual([0, 50, 100])
  })

  it('clamps an aligned member to an unselected frame just like dragging', () => {
    const frame = node('frame', { kind: 'frame', w: 600, h: 400 })
    const member = node('member', { frameId: 'frame', x: 80, y: 100 })
    const outside = node('outside', { x: -200, y: -200 })
    expect(constrainedMoves([frame, member, outside], alignTargets([member, outside], 'alignLeft'))).toContainEqual({ nodeId: 'member', x: 24, y: 100 })
    expect(constrainedMoves([frame, member, outside], alignTargets([member, outside], 'alignTop'))).toContainEqual({ nodeId: 'member', x: 80, y: 56 })
  })

  it('moves selected frames and their recursive members through the same path as a drag', () => {
    const frame = node('frame', { kind: 'frame', x: 200, y: 200, w: 600, h: 500 })
    const inner = node('inner', { kind: 'frame', frameId: 'frame', x: 250, y: 270, w: 300, h: 220 })
    const member = node('member', { frameId: 'inner', x: 280, y: 330 })
    const outside = node('outside', { x: 0, y: 0 })
    const all = [frame, inner, member, outside]
    const moves = constrainedMoves(all, alignTargets([frame, member, outside], 'alignLeft'))
    expect(memberMoveOps(all, moves)).toEqual([
      { op: 'frame.move', nodeId: 'frame', dx: -200, dy: 0 },
      { op: 'node.layout', nodeId: 'outside', x: 0, y: 0 },
      { op: 'node.layout', nodeId: 'frame', x: 0, y: 200 },
    ])
    expect(movedFrameBounds(all, moves)).toContainEqual({ nodeId: 'member', x: 80, y: 330, w: 100, h: 80 })
  })
})

describe('Snap guides', () => {
  it.each([0.5, 1, 2])('uses a six-screen-pixel threshold at zoom %s', zoom => {
    const threshold = 6 / zoom
    expect(querySnap({ x: 100 + threshold, y: 0, w: 20, h: 20 }, { x: [100], y: [] }, zoom)).toEqual({ dx: -threshold, dy: 0, guides: { x: 100 } })
    expect(querySnap({ x: 100 + threshold + 0.01, y: 0, w: 20, h: 20 }, { x: [100], y: [] }, zoom).guides).toEqual({})
  })

  it('chooses the nearest edge or center on each axis', () => {
    expect(querySnap({ x: 97, y: 46, w: 20, h: 20 }, { x: [94, 99, 110, 120], y: [44, 47, 80] }, 1)).toEqual({
      dx: 2, dy: 1, guides: { x: 99, y: 47 },
    })
  })

  it('snaps group bounds together rather than an arbitrary member', () => {
    const group = [node('a', { x: 103, y: 40 }), node('b', { x: 300, y: 200 })]
    const bounds = selectionBounds(group)!
    expect(bounds).toEqual({ x: 103, y: 40, w: 297, h: 240 })
    expect(querySnap(bounds, { x: [100], y: [283] }, 1)).toEqual({ dx: -3, dy: 3, guides: { x: 100, y: 283 } })
  })

  it('excludes dragged nodes, recursive frame members, hidden working nodes and offscreen nodes', () => {
    const nodes = [
      node('frame', { kind: 'frame', x: 10 }), node('inner', { kind: 'frame', frameId: 'frame', x: 20 }),
      node('member', { frameId: 'inner', x: 30 }), node('dragged', { x: 40 }), node('working', { purpose: 'working', x: 50 }),
      node('offscreen', { x: 2000 }), node('visible', { x: 300, y: 200 }),
    ]
    const viewport = { x: 0, y: 0, w: 600, h: 500 }
    expect(buildSnapCandidates(nodes, ['frame', 'dragged'], viewport)).toEqual({ x: [300, 350, 400], y: [200, 240, 280] })
    expect(buildSnapCandidates(nodes, [], viewport, new Set(['working']))).toEqual({ x: [50, 100, 150], y: [0, 40, 80] })
  })

  it('deduplicates and sorts candidate lines, including cards partially in the viewport', () => {
    expect(buildSnapCandidates([node('a', { x: -50 }), node('b')], [], { x: 0, y: 0, w: 500, h: 400 })).toEqual({
      x: [-50, 0, 50, 100], y: [0, 40, 80],
    })
  })

  it('removes a guide when frame clamping undoes the snap', () => {
    expect(matchingSnapLines({ x: 24, y: 56, w: 100, h: 80 }, { x: 0, y: 56 })).toEqual({ y: 56 })
  })
})
