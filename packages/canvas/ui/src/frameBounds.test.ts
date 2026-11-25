import { describe, expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { constrainedMoves, fitFrameOps, frameCreationOps, growFrames, leaveFrameOps, memberMoveOps } from './frameBounds'

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({ nodeId, kind: 'text', x: 40, y: 70, w: 100, h: 80, z: 0, layoutRevision: 0, slots: [], ...extra })
const frame = node('frame', { kind: 'frame', x: 0, y: 0, w: 400, h: 300 })
const child = node('child', { frameId: 'frame' })

describe('Frame bounds', () => {
  it('All four boundaries include padding; modifier keys allow crossing them', () => {
    const moves = [{ nodeId: 'child', x: 999, y: -300 }]
    expect(constrainedMoves([frame, child], moves)).toEqual([{ nodeId: 'child', x: 276, y: 56 }])
    expect(constrainedMoves([frame, child], moves, true)).toEqual(moves)
    expect(constrainedMoves([frame, child], [{ nodeId: 'child', x: -90, y: 900 }])).toEqual([{ nodeId: 'child', x: 24, y: 196 }])
  })
  it('Nested frames are constrained by their parent; moving parent and child together applies no separate constraint', () => {
    const inner = { ...child, kind: 'frame' as const }
    expect(constrainedMoves([frame, inner], [{ nodeId: 'child', x: 900, y: 800 }])[0]).toMatchObject({ x: 276, y: 196 })
    expect(constrainedMoves([frame, inner], [{ nodeId: 'frame', x: 900, y: 800 }, { nodeId: 'child', x: 940, y: 870 }])[1]).toMatchObject({ x: 940, y: 870 })
    expect(memberMoveOps([frame, child], [{ nodeId: 'frame', x: 900, y: 800 }])).toEqual([{ op: 'frame.move', nodeId: 'frame', dx: 900, dy: 800 }, { op: 'node.layout', nodeId: 'frame', x: 900, y: 800 }])
  })
  it('Expand from inside out without shrinking user dimensions or changing node content', () => {
    const inner = node('inner', { kind: 'frame', frameId: 'frame', x: 100, y: 100, w: 320, h: 200 })
    const large = node('large', { frameId: 'inner', x: 120, y: 150, w: 500, h: 400 })
    const ops = growFrames([frame, inner, large])
    expect(ops[0]).toMatchObject({ nodeId: 'inner', x: 96, y: 94, w: 548, h: 480 })
    expect(ops[1]).toMatchObject({ nodeId: 'frame', w: 668, h: 598 })
    expect(growFrames([frame, child])).toEqual([])
    expect(growFrames([frame])).toEqual([])
    expect(frame.w).toBe(400)
  })
  it('Move outside the frame with nested members following', () => {
    expect(leaveFrameOps(child, [frame, child])).toEqual([{ op: 'node.layout', nodeId: 'child', x: 480, y: 70 }])
    expect(leaveFrameOps(node('free'), [frame])).toEqual([])
  })
  it('creates a nested frame after growing its parent in the same batch', () => {
    const create = { op: 'frame.create' as const, tempId: 'new', title: 'Frame', x: 16, y: 14, w: 360, h: 280 }
    const ops = frameCreationOps([frame, child], create, 'frame')
    expect(ops).toEqual([
      { op: 'node.layout', nodeId: 'frame', x: -8, y: -42, w: 408, h: 360 },
      create,
    ])
    expect(frameCreationOps([child], create, null)).toEqual([create])
  })
  it('fits only the target frame, leaving members and an already large ancestor unchanged', () => {
    const outer = { ...frame, w: 1200, h: 900 }
    const inner = node('inner', { kind: 'frame', frameId: 'frame', x: 50, y: 80, w: 800, h: 600 })
    const member = node('member', { frameId: 'inner', x: 150, y: 250 })
    const before = structuredClone([outer, inner, member])
    expect(fitFrameOps(inner, before)).toEqual([{ op: 'node.layout', nodeId: 'inner', x: 126, y: 194, w: 320, h: 200 }])
    expect(before).toEqual([outer, inner, member])
    expect(fitFrameOps({ ...inner, x: 126, y: 194, w: 320, h: 200 }, before)).toEqual([])
    expect(fitFrameOps(frame, [frame])).toEqual([])
  })
  it('grows every ancestor before fitting without moving any member', () => {
    const outer = { ...frame, w: 600, h: 500 }
    const inner = node('inner', { kind: 'frame', frameId: 'frame', x: 100, y: 150, w: 320, h: 200 })
    const member = node('member', { frameId: 'inner', x: 300, y: 300, w: 700, h: 500 })
    expect(fitFrameOps(inner, [outer, inner, member])).toEqual([
      { op: 'node.layout', nodeId: 'frame', x: 0, y: 0, w: 1048, h: 848 },
      { op: 'node.layout', nodeId: 'inner', x: 276, y: 244, w: 748, h: 580 },
    ])
  })
  it('orders multiple ancestor layouts from outside in before the fitted frame', () => {
    const outer = { ...frame, w: 600, h: 500 }
    const middle = node('middle', { kind: 'frame', frameId: 'frame', x: 100, y: 100, w: 400, h: 300 })
    const inner = node('inner', { kind: 'frame', frameId: 'middle', x: 150, y: 170, w: 320, h: 200 })
    const member = node('member', { frameId: 'inner', x: 300, y: 300, w: 700, h: 500 })
    expect(fitFrameOps(inner, [outer, middle, inner, member])).toEqual([
      { op: 'node.layout', nodeId: 'frame', x: 0, y: 0, w: 1072, h: 872 },
      { op: 'node.layout', nodeId: 'middle', x: 100, y: 100, w: 948, h: 748 },
      { op: 'node.layout', nodeId: 'inner', x: 276, y: 244, w: 748, h: 580 },
    ])
  })
})
