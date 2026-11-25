import { describe, expect, it } from 'vitest'
import type { NodeView } from '@vis/protocol'
import { fitFrameBounds, frameSelectionBounds, FRAME_MIN_SIZE } from './frames'

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({
  nodeId, kind: 'text', x: 100, y: 200, w: 320, h: 200, z: 0, layoutRevision: 0, slots: [], ...extra,
})

describe('Author frame bounds', () => {
  it('adds side and bottom padding and a header around a selection, ignoring selected frames', () => {
    expect(frameSelectionBounds([node('a'), node('b', { x: 500, y: 400, w: 100, h: 80 }), node('frame', { kind: 'frame', x: -1000 })]))
      .toEqual({ bounds: { x: 76, y: 144, w: 548, h: 360 }, frameId: null })
  })

  it('enforces minimum dimensions and ignores an empty or frame-only selection', () => {
    expect(frameSelectionBounds([node('small', { w: 10, h: 10 })]))
      .toEqual({ bounds: { x: 76, y: 144, ...FRAME_MIN_SIZE }, frameId: null })
    expect(frameSelectionBounds([])).toBeNull()
    expect(frameSelectionBounds([node('frame', { kind: 'frame' })])).toBeNull()
  })

  it('refuses different innermost frames, including open canvas mixed with a frame', () => {
    expect(frameSelectionBounds([node('a', { frameId: 'outer' }), node('b', { frameId: 'inner' })])).toEqual({ error: 'cross-frame' })
    expect(frameSelectionBounds([node('a'), node('b', { frameId: 'inner' })])).toEqual({ error: 'cross-frame' })
    expect(frameSelectionBounds([node('a', { frameId: null }), node('b')])).toHaveProperty('frameId', null)
    expect(frameSelectionBounds([node('a', { frameId: 'inner' }), node('b', { frameId: 'inner' })])).toHaveProperty('frameId', 'inner')
  })

  it('fits direct members, including nested frames, and keeps every member center inside', () => {
    const frame = node('frame', { kind: 'frame', x: -200, y: -300, w: 2000, h: 1600 })
    const members = [node('a', { frameId: 'frame' }), node('nested', { kind: 'frame', frameId: 'frame', x: 500, y: 500, w: 500, h: 300 })]
    const bounds = fitFrameBounds(frame, [frame, ...members, node('descendant', { frameId: 'nested', x: 900, y: 700 })])!
    expect(bounds).toEqual({ x: 76, y: 144, w: 948, h: 680 })
    expect(bounds.w).toBeLessThan(frame.w)
    expect(bounds.h).toBeLessThan(frame.h)
    for (const member of members) {
      expect(member.x + member.w / 2).toBeGreaterThanOrEqual(bounds.x)
      expect(member.x + member.w / 2).toBeLessThanOrEqual(bounds.x + bounds.w)
      expect(member.y + member.h / 2).toBeGreaterThanOrEqual(bounds.y)
      expect(member.y + member.h / 2).toBeLessThanOrEqual(bounds.y + bounds.h)
    }
    expect(members[0]).toMatchObject({ x: 100, y: 200 })
  })

  it('grows around overflowing content, uses minimum dimensions and leaves empty frames alone', () => {
    const frame = node('frame', { kind: 'frame', x: 0, y: 0, ...FRAME_MIN_SIZE })
    expect(fitFrameBounds(frame, [node('a', { frameId: 'frame', x: -50, y: -30, w: 600, h: 500 })]))
      .toEqual({ x: -74, y: -86, w: 648, h: 580 })
    expect(fitFrameBounds(frame, [node('tiny', { frameId: 'frame', w: 1, h: 1 })]))
      .toEqual({ x: 76, y: 144, ...FRAME_MIN_SIZE })
    expect(fitFrameBounds(frame, [node('unrelated')])).toBeNull()
  })
})
