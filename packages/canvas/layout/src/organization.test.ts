import { describe, expect, it } from 'vitest'
import { CanvasOp, type NodeView } from '@vis/protocol'
import { EMPTY_SCRIPT } from '@vis/protocol'
import { planOrganize, growFrames, NODE_GAP, organizeGrid, organizePlanDigest, type OrganizeInput } from './index'
const arrangeCanvas = (nodes: NodeView[], selected?: ReadonlySet<string>, locale = 'zh-CN', columns: number | 'auto' = 1) => {
  const plan = planOrganize({ nodes, mode: 'category', nodeIds: selected?.size ? [...selected] : undefined, columns, removeEmptyFrames: true,
    titles: { uncategorized: locale === 'en' ? 'Uncategorized' : '未分类', untitledScript: 'Untitled script' } })
  return { ...plan, groups: plan.groups.map(({ title, ...group }) => ({ ...group, category: title })) }
}

const node = (nodeId: string, extra: Partial<NodeView> = {}): NodeView => ({
  nodeId, kind: 'image', x: 0, y: 0, w: 320, h: 320, z: 0, layoutRevision: 0, slots: [], ...extra,
})
const frame = (nodeId: string, title: string, extra: Partial<NodeView> = {}) => node(nodeId, {
  kind: 'frame', w: 1000, h: 1200, frame: { title, color: 'gray' }, ...extra,
})
const finalNodes = (nodes: NodeView[], ops: CanvasOp[]) => nodes.map(node => ({
  ...node, ...ops.filter(op => op.op === 'node.layout' && op.nodeId === node.nodeId)
    .reduce((layout, op) => ({ ...layout, ...op }), {}),
}))
const applyPlan = (nodes: NodeView[], ops: CanvasOp[]) => {
  let placed = structuredClone(nodes)
  for (const op of ops) {
    if (op.op === 'frame.create') placed.push(frame(`created-${op.tempId}`, op.title, { x: op.x, y: op.y, w: op.w, h: op.h }))
    else if (op.op === 'node.layout') {
      const item = placed.find(node => node.nodeId === op.nodeId)!
      for (const key of ['x', 'y', 'w', 'h'] as const) if (op[key] !== undefined) item[key] = op[key]
    } else if (op.op === 'node.delete') placed = placed.filter(node => node.nodeId !== op.nodeId)
    else throw new Error(`Unexpected organization operation: ${op.op}`)
  }
  const frames = placed.filter(node => node.kind === 'frame').sort((a, b) => a.w * a.h - b.w * b.h || a.nodeId.localeCompare(b.nodeId))
  return placed.map(node => ({
    ...node,
    frameId: frames.find(frame => frame.nodeId !== node.nodeId
      && (node.kind !== 'frame' || frame.w * frame.h > node.w * node.h)
      && node.x + node.w / 2 >= frame.x && node.x + node.w / 2 <= frame.x + frame.w
      && node.y + node.h / 2 >= frame.y && node.y + node.h / 2 <= frame.y + frame.h)?.nodeId ?? null,
  }))
}
const overlap = (a: NodeView, b: NodeView) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

describe('Organize canvas by category', () => {
  it('Keep current reading order instead of creation order across frames and the open canvas', () => {
    const nodes = [frame('upper', 'Upper', { x: 500, y: -1000 }), frame('lower', 'Lower', { x: -500, y: 1000 }),
      node('a', { category: 'Art', x: 0, y: 500 }),
      node('b', { category: 'Art', x: -400, y: 1100, frameId: 'lower' }),
      node('c', { category: 'Art', x: 600, y: -900, frameId: 'upper' })]
    const plan = arrangeCanvas(nodes)
    expect(plan.groups[0]!.nodeIds).toEqual(['c', 'a', 'b'])
    const placed = finalNodes(nodes, plan.ops)
    expect(placed.find(node => node.nodeId === 'c')!.y).toBeLessThan(placed.find(node => node.nodeId === 'a')!.y)
    expect(placed.find(node => node.nodeId === 'a')!.y).toBeLessThan(placed.find(node => node.nodeId === 'b')!.y)
    expect(arrangeCanvas([...nodes].reverse())).toEqual(plan)
  })

  it('Treat nearby top edges as a row before ordering left to right', () => {
    const nodes = [node('a', { x: 500, y: 100 }), node('b', { x: 0, y: 105 }), node('c', { x: -500, y: 600 })]
    expect(arrangeCanvas(nodes).groups[0]!.nodeIds).toEqual(['b', 'a', 'c'])
  })

  it('Anchor row bands to the topmost member instead of chaining nearby rows', () => {
    const nodes = [node('a', { x: 1000, y: 0 }), node('b', { x: 500, y: NODE_GAP / 2 }),
      node('c', { x: 0, y: NODE_GAP / 2 + 1 })]
    expect(arrangeCanvas(nodes).groups[0]!.nodeIds).toEqual(['b', 'a', 'c'])
  })

  it('Break position ties by node ID independently of input order', () => {
    const nodes = [node('c'), node('a'), node('b')]
    expect(arrangeCanvas(nodes).groups[0]!.nodeIds).toEqual(['a', 'b', 'c'])
    expect(arrangeCanvas([...nodes].reverse())).toEqual(arrangeCanvas(nodes))
  })

  it.each([
    { selectedOnly: false, columns: 1 }, { selectedOnly: false, columns: 2 },
    { selectedOnly: true, columns: 1 }, { selectedOnly: true, columns: 2 },
  ])('A second organize is a no-op with mixed heights, $columns columns and selectedOnly=$selectedOnly', ({ selectedOnly, columns }) => {
    const members = Array.from({ length: columns === 1 ? 3 : 6 }, (_, index) => node(`item-${index}`, {
      ...[{ kind: 'image' as const, w: 213, h: 320 }, { kind: 'video' as const, w: 200, h: 112 }, { kind: 'text' as const, w: 200, h: 120 }][index % 3]!,
      category: 'Art', x: index % 2 === 0 ? 500 : 0, y: Math.floor(index / 2) * 700 + (index % 2) * 5,
    }))
    const nodes = selectedOnly ? [...members, node('fixed', { x: -1000, y: -1000 })] : members
    const selected = selectedOnly ? new Set(members.map(node => node.nodeId)) : undefined
    const plan = arrangeCanvas(nodes, selected, 'zh-CN', columns)
    expect(plan.ops.some(op => op.op === 'frame.create')).toBe(true)
    const placed = applyPlan(nodes, plan.ops)
    const group = plan.groups[0]!
    expect(new Set(members.map(member => placed.find(node => node.nodeId === member.nodeId)!.x)).size).toBe(columns)
    for (const member of members) expect(placed.find(node => node.nodeId === member.nodeId)!.frameId).toBe(`created-${group.frameId}`)
    const again = arrangeCanvas(placed, selected, 'zh-CN', columns)
    expect(again.groups[0]!.nodeIds).toEqual(group.nodeIds)
    expect(again.ops).toEqual([])
  })

  it.each([1, 2, 'auto'] as const)('A second selected organize is a no-op in an anchored frame with mixed heights and %s columns', columns => {
    const members = Array.from({ length: columns === 1 ? 3 : 6 }, (_, index) => node(`item-${index}`, {
      ...[{ kind: 'image' as const, w: 213, h: 320 }, { kind: 'video' as const, w: 200, h: 112 }, { kind: 'text' as const, w: 200, h: 120 }][index % 3]!,
      category: 'Art', x: 800 + index % 2 * 400, y: 400 + Math.floor(index / 2) * 700, frameId: 'art',
    }))
    const nodes = [frame('outer', 'Outer', { x: 0, y: 0, w: 2500, h: 2200 }),
      frame('art', 'Art', { x: 100, y: 200, w: 1800, h: 2000, frameId: 'outer' }),
      node('fixed', { x: 124, y: 256, w: 320, h: 700, frameId: 'art' }), ...members]
    const selected = new Set(members.map(node => node.nodeId))
    const plan = arrangeCanvas(nodes, selected, 'zh-CN', columns)
    expect(plan.groups[0]).toMatchObject({ frameId: 'art', x: 100, y: 200 })
    const placed = applyPlan(nodes, plan.ops)
    expect(placed.find(node => node.nodeId === 'fixed')).toEqual(nodes[2])
    for (const member of members) expect(placed.find(node => node.nodeId === member.nodeId)!.frameId).toBe('art')
    const again = arrangeCanvas(placed, selected, 'zh-CN', columns)
    expect(again.groups).toEqual(plan.groups)
    expect(again.ops).toEqual([])
  })

  it('Keep media aspect ratios when unifying widths', () => {
    const nodes = [
      node('portrait', { category: '人物', w: 213, h: 320 }),
      node('square', { category: '人物' }),
      node('note', { category: '人物', kind: 'text', w: 200, h: 120 }),
    ]
    const placed = finalNodes(nodes, arrangeCanvas(nodes).ops)
    expect(placed.map(({ w, h }) => ({ w, h }))).toEqual([{ w: 320, h: 481 }, { w: 320, h: 320 }, { w: 200, h: 120 }])
    expect(placed.every((item, index) => placed.every((other, otherIndex) => index === otherIndex || !overlap(item, other)))).toBe(true)
  })

  it('Create category frames and unify group widths while preserving content and relationships in a single layout batch', () => {
    const nodes = [node('small', { category: '人物', w: 250 }), node('wide', { category: '人物', w: 400 }), node('uncategorized')]
    const before = structuredClone(nodes)
    const plan = arrangeCanvas(nodes)
    expect(plan.groups.map(group => group.category)).toEqual(['人物', '未分类'])
    expect(plan.groups[0]!.nodeIds).toEqual(['small', 'wide'])
    expect(plan.ops.filter(op => op.op === 'frame.create')).toHaveLength(2)
    expect(plan.ops.every(op => op.op === 'node.layout' || op.op.startsWith('frame.'))).toBe(true)
    expect(plan.ops.every(op => CanvasOp.safeParse(op).success)).toBe(true)
    expect(nodes).toEqual(before)
    const placed = finalNodes(nodes, plan.ops)
    expect(placed.slice(0, 2).map(node => node.w)).toEqual([400, 400])
    expect(placed.every((node, index) => placed.every((other, otherIndex) => index === otherIndex || !overlap(node, other)))).toBe(true)
    for (const group of plan.groups) for (const id of group.nodeIds) {
      const item = placed.find(node => node.nodeId === id)!
      expect(item.x).toBeGreaterThanOrEqual(group.x + 24)
      expect(item.y).toBeGreaterThanOrEqual(group.y + 56)
      expect(item.x + item.w).toBeLessThanOrEqual(group.x + group.w - 24)
      expect(item.y + item.h).toBeLessThanOrEqual(group.y + group.h - 24)
    }
  })

  it('Upstream provenance and reference partitions sit on the left; input order does not affect the result', () => {
    const nodes = [node('video', { category: '镜头', inputs: ['person'] }), node('person', { category: '人物' }), node('scene', { category: '场景' })]
    nodes[0]!.slots = [{ slotId: 'main', slotKey: 'main', contentType: 'video', revision: 1, content: { type: 'empty' },
      source: { jobId: 'job', inputNodeIds: ['scene', 'scene', 'missing', 'video'] } }]
    const plan = arrangeCanvas(nodes)
    const x = (category: string) => plan.groups.find(group => group.category === category)!.x
    expect(x('人物')).toBeLessThan(x('镜头'))
    expect(x('场景')).toBeLessThan(x('镜头'))
    expect(arrangeCanvas([...nodes].reverse())).toEqual(plan)
  })

  it('Cyclic partitions converge stably; upstream and downstream partitions outside the cycle remain on opposite sides', () => {
    const nodes = [node('a', { category: 'A', inputs: ['b', 'source'] }), node('b', { category: 'B', inputs: ['a'] }),
      node('source', { category: 'Z' }), node('target', { category: 'C', inputs: ['b'] })]
    const plan = arrangeCanvas(nodes)
    expect(plan.groups.map(group => group.category)).toEqual(['Z', 'A', 'B', 'C'])
    expect(arrangeCanvas([...nodes].reverse())).toEqual(plan)
  })

  it('Work documents are never organized or treated as obstacles', () => {
    const artifact = node('artifact', { category: '文案' })
    const working = node('working', { purpose: 'working', x: -10000, y: -10000, w: 100000, h: 100000, category: '计划' })
    expect(arrangeCanvas([working, artifact])).toEqual(arrangeCanvas([artifact]))
    expect(arrangeCanvas([working], new Set(['working']))).toEqual({ ops: [], groups: [], removedFrames: [], untouched: [] })
    expect(arrangeCanvas([frame('f', '空框')]).ops).toEqual([{ op: 'node.delete', nodeId: 'f' }])
  })

  it('Partial selection preserves unselected members and original frame positions; the grid avoids unselected nodes and other frames', () => {
    const nodes = [frame('people', '人物', { x: 100, y: 200 }),
      node('selected', { category: '人物', x: 600, y: 300, frameId: 'people' }),
      node('fixed', { x: 124, y: 256, frameId: 'people', h: 700 }),
      node('outside', { x: 524, y: 1100 }), frame('nested', '嵌套', { x: 124, y: 1500, w: 600, h: 300, frameId: 'people' })]
    const plan = arrangeCanvas(nodes, new Set(['selected']))
    const placed = finalNodes(nodes, plan.ops)
    const group = plan.groups[0]!
    expect(group.frameId).toBe('people')
    expect(group).toMatchObject({ x: 100, y: 200, w: 1000 })
    expect(plan.ops.filter(op => 'nodeId' in op).every(op => 'nodeId' in op && ['people', 'selected'].includes(op.nodeId))).toBe(true)
    expect(placed.filter(node => !['people', 'selected'].includes(node.nodeId))).toEqual(nodes.filter(node => !['people', 'selected'].includes(node.nodeId)))
    expect(nodes.slice(2).every(obstacle => !overlap(placed[1]!, obstacle))).toBe(true)
    expect(placed[1]!.y + placed[1]!.h).toBeLessThanOrEqual(group.y + group.h - 24)
  })

  it('New partitions for partial selection avoid all visible unselected outputs without changing their layout', () => {
    const nodes = [node('chosen', { category: '镜头' }), node('fixed', { w: 800, h: 2000 }), frame('fixed-frame', '其他', { x: 1000, w: 1000 })]
    const plan = arrangeCanvas(nodes, new Set(['chosen']))
    const placed = finalNodes(nodes, plan.ops)
    expect(placed[1]).toEqual(nodes[1])
    expect(placed[2]).toEqual(nodes[2])
    expect(nodes.slice(1).every(obstacle => !overlap(placed[0]!, obstacle))).toBe(true)
  })

  it('Nested partitions do not avoid their ancestors; expanding ancestors in the same batch needs no extra undo batch', () => {
    const nodes = [frame('outer', '总览', { w: 1500, h: 1800 }), frame('people', '人物', { x: 24, y: 56, w: 1000, h: 1600, frameId: 'outer' }),
      node('chosen', { category: '人物', x: 400, y: 800, frameId: 'people' }), node('fixed', { x: 48, y: 112, h: 1300, frameId: 'people' })]
    const plan = arrangeCanvas(nodes, new Set(['chosen']))
    expect(plan.groups[0]).toMatchObject({ frameId: 'people', x: 24, y: 56 })
    const placed = finalNodes(nodes, plan.ops)
    expect(placed[0]!.h).toBeGreaterThan(1800)
    expect(growFrames(placed)).toEqual([])
    expect(placed[3]).toEqual(nodes[3])
  })

  it('New partitions fit the grid; manually widened frames retain their proportions', () => {
    for (const kind of ['text', 'image', 'audio'] as const) {
      for (const count of [1, 2, 3, 4]) {
        const plan = arrangeCanvas(Array.from({ length: count }, (_, index) => node(`${index}`, { kind, h: 140 })))
        expect(plan.groups[0]!.h).toBeGreaterThanOrEqual(56 + count * (140 + NODE_GAP) - NODE_GAP + 24)
      }
    }
    const plan = arrangeCanvas([frame('f', '人物', { w: 2400, h: 500 }), node('a', { category: '人物' })])
    expect(plan.groups[0]).toMatchObject({ w: 2400, h: 500 })
  })

  it('Existing frame dimensions only grow; sufficiently large manual dimensions remain unchanged', () => {
    const nodes = [frame('people', '人物', { x: -100, y: -200, w: 2400, h: 4000 }), node('person', { category: '人物', x: 100, y: 100, frameId: 'people' })]
    const plan = arrangeCanvas(nodes)
    expect(plan.groups).toEqual([{ category: '人物', frameId: 'people', nodeIds: ['person'], x: -100, y: -200, w: 2400, h: 4000 }])
    expect(plan.ops.some(op => op.op === 'frame.create')).toBe(false)
    expect(plan.ops.some(op => op.op === 'node.layout' && op.nodeId === 'people')).toBe(false)
    const small = arrangeCanvas([frame('small', '人物', { w: 320, h: 200 }), node('person', { category: '人物', h: 800 })])
    expect(small.groups[0]!.w).toBeGreaterThanOrEqual(320)
    expect(small.groups[0]!.h).toBeGreaterThanOrEqual(880)
  })

  it('Empty selection organizes everything; identical layouts generate no duplicate operations', () => {
    const nodes = [frame('f', '人物', { x: 0, y: 0, w: 368, h: 400 }), node('a', { category: '人物', x: 24, y: 56, frameId: 'f' })]
    expect(arrangeCanvas(nodes, new Set())).toEqual(arrangeCanvas(nodes))
    expect(arrangeCanvas(nodes).ops).toEqual([])
  })

  it('The node limit includes created frames and returns data instead of throwing', () => {
    expect(arrangeCanvas(Array.from({ length: 999 }, (_, index) => node(`item-${index}`))).tooLarge).toBeUndefined()
    expect(arrangeCanvas(Array.from({ length: 1000 }, (_, index) => node(`item-${index}`))).tooLarge).toEqual({ count: 1001, limit: 1000 })
  })

  it('Temporary IDs for new frames do not shadow existing node IDs, including hidden nodes', () => {
    const plan = arrangeCanvas([node('organize-frame-0'), node('organize-frame-1', { purpose: 'working' })])
    expect(plan.groups[0]!.frameId).toBe('organize-frame-2')
    expect(plan.ops).toContainEqual(expect.objectContaining({ op: 'node.layout', nodeId: 'organize-frame-0' }))
  })
})

it('English organization translates only the uncategorized title, preserving existing categories and node data', () => {
  const nodes = [node('categorized', { category: '人物' }), node('uncategorized')]
  const before = structuredClone(nodes)
  const plan = arrangeCanvas(nodes, undefined, 'en')
  expect(plan.groups.map(group => group.category)).toEqual(['Uncategorized', '人物'])
  expect(plan.ops.filter(op => op.op === 'frame.create').map(op => op.title)).toEqual(['Uncategorized', '人物'])
  expect(nodes).toEqual(before)
})

it('Reuse uncategorized frames after switching languages, preferring the current language without changing old titles', () => {
  const nodes = [frame('zh-frame', '未分类'), node('uncategorized', { x: 24, y: 56, frameId: 'zh-frame' })]
  expect(arrangeCanvas(nodes).ops.some(op => op.op === 'frame.create')).toBe(false)
  const english = arrangeCanvas(nodes, undefined, 'en')
  expect(english.groups[0]!.frameId).toBe('zh-frame')
  expect(english.ops.some(op => op.op === 'frame.create')).toBe(false)
  expect(nodes[0]!.frame!.title).toBe('未分类')
  const both = [...nodes, frame('en-frame', 'Uncategorized', { x: 2000 })]
  expect(arrangeCanvas(both, undefined, 'en').groups[0]!.frameId).toBe('en-frame')
  expect(arrangeCanvas(both, undefined, 'zh-CN').groups[0]!.frameId).toBe('zh-frame')
  expect(arrangeCanvas([frame('en-frame', 'Uncategorized'), node('uncategorized')]).groups[0]!.frameId).toBe('en-frame')
})

it('Cross-language uncategorized frame fallback does not claim a frame belonging to another existing category', () => {
  const plan = arrangeCanvas([frame('zh-frame', '未分类'), node('explicit', { category: '未分类' }), node('uncategorized')], undefined, 'en')
  expect(plan.groups.find(group => group.category === '未分类')!.frameId).toBe('zh-frame')
  expect(new Set(plan.groups.map(group => group.frameId)).size).toBe(2)
})

it('removes frames emptied by tidy, including old empty frames, while retaining targets and every member', () => {
  const nodes = [frame('old', 'Old'), frame('empty', 'Empty'), frame('target', 'Art'), node('art', { category: 'Art', frameId: 'old' })]
  const plan = arrangeCanvas(nodes)
  expect(plan.removedFrames.map(frame => frame.nodeId)).toEqual(['empty', 'old'])
  expect(plan.ops.filter(op => op.op === 'node.delete')).toEqual([{ op: 'node.delete', nodeId: 'empty' }, { op: 'node.delete', nodeId: 'old' }])
  expect(plan.groups[0]?.frameId).toBe('target')
  expect(plan.ops.every(op => op.op !== 'node.delete' || nodes.find(node => node.nodeId === op.nodeId)?.kind === 'frame')).toBe(true)
  expect(arrangeCanvas([frame('empty', 'Empty')]).ops).toEqual([{ op: 'node.delete', nodeId: 'empty' }])
})

it('selected tidy only removes frames it emptied and keeps frames with unselected or working members', () => {
  const nodes = [frame('old', 'Old'), frame('empty', 'Empty'), frame('partial', 'Partial'),
    node('selected', { category: 'Art', frameId: 'old' }), node('selected2', { category: 'Art', frameId: 'partial' }), node('keep', { frameId: 'partial' })]
  expect(arrangeCanvas(nodes, new Set(['selected', 'selected2'])).removedFrames.map(frame => frame.nodeId)).toEqual(['old'])
  expect(arrangeCanvas([...nodes, node('working', { frameId: 'old', purpose: 'working' })]).removedFrames.map(frame => frame.nodeId)).not.toContain('old')
})

it('removes emptied ancestors of relocated category frames while retaining untouched nested empty frames in selected tidy', () => {
  const nodes = [frame('outer', 'Outer'), frame('target', 'Art', { frameId: 'outer' }), node('art', { category: 'Art', frameId: 'target' })]
  expect(arrangeCanvas(nodes).removedFrames.map(frame => frame.nodeId)).toEqual(['outer'])
  expect(arrangeCanvas(nodes, new Set(['art'])).removedFrames.map(frame => frame.nodeId)).toEqual(['outer'])
  expect(arrangeCanvas([...nodes, node('working', { frameId: 'target', purpose: 'working' })]).removedFrames).toEqual([])
  expect(arrangeCanvas([...nodes, frame('empty', 'Empty', { frameId: 'target' })], new Set(['art'])).removedFrames).toEqual([])
  const nested = [frame('outer', 'Outer'), frame('empty', 'Empty', { frameId: 'outer' }), node('art', { category: 'Art', frameId: 'outer' })]
  expect(arrangeCanvas(nested, new Set(['art'])).removedFrames).toEqual([])
  expect(arrangeCanvas(nested).removedFrames.map(frame => frame.nodeId)).toEqual(['empty', 'outer'])
})

const titles = { uncategorized: 'Uncategorized', untitledScript: 'Untitled script' }
const plan = (nodes: NodeView[], extra: Partial<OrganizeInput> = {}) => planOrganize({ nodes, mode: 'category', removeEmptyFrames: true, titles, ...extra })
const scriptNode = (order = ['shot-b', 'shot-a']) => node('script', { kind: 'script', title: 'Storyboard', x: -1000,
  slots: [{ slotId: 'script-main', slotKey: 'main', contentType: 'script', revision: 1, content: { type: 'script', doc: {
    ...EMPTY_SCRIPT, shots: order.map(id => ({ id, rev: 1, description: id, transition: 'cut', characterIds: [], propIds: [] })),
  } } }] })
const linked = (id: string, shotId: string, role: NonNullable<NodeView['shot']>['role'], extra: Partial<NodeView> = {}) =>
  node(id, { shot: { scriptNodeId: 'script', shotId, role }, ...extra })

it('auto columns minimize log aspect distance to 4:3 and numeric columns override it', () => {
  const nodes = Array.from({ length: 6 }, (_, index) => node(`${index}`))
  expect(organizeGrid(nodes).columns).toBe(3)
  expect(organizeGrid(nodes, 1).columns).toBe(1)
  expect(organizeGrid(nodes, 8).columns).toBe(6)
  const h = (-80 + Math.sqrt(80 ** 2 + 8 * 320 * 720 * 9 / 16)) / 4
  const tied = [node('a', { kind: 'text', h }), node('b', { kind: 'text', h })]
  expect(organizeGrid(tied).columns).toBe(1)
})

it('rows use their own tallest height, columns their own widest card, and only media unify width', () => {
  const nodes = [node('image', { w: 400, h: 600 }), node('script', { kind: 'script', w: 480, h: 320 }),
    node('video', { kind: 'video', w: 320, h: 180 }), node('note', { kind: 'text', w: 180, h: 100 })]
  const grid = organizeGrid(nodes, 2)
  expect(grid.cells).toEqual([
    { x: 0, y: 0, w: 400, h: 600 }, { x: 480, y: 0, w: 480, h: 320 },
    { x: 0, y: 680, w: 400, h: 225 }, { x: 480, y: 680, w: 180, h: 100 },
  ])
  expect(grid.h).toBe(905)
})

it('script rows follow shot order, role columns omit absent roles, duplicates share a cell, and unlinked nodes stay untouched', () => {
  const nodes = [scriptNode(), linked('a', 'shot-a', 'video'), linked('b-right', 'shot-b', 'first', { x: 400 }),
    linked('b-left', 'shot-b', 'first'), linked('last', 'shot-b', 'previz'), node('upload'),
    linked('orphan', 'shot-a', 'last', { shot: { scriptNodeId: 'gone', shotId: 'shot-a', role: 'last' } })]
  const result = plan(nodes, { mode: 'script', columns: 1 })
  const placed = applyPlan(nodes, result.ops)
  const at = (id: string) => placed.find(node => node.nodeId === id)!
  expect(result.groups[0]!.title).toBe('Storyboard')
  expect(at('b-left').y).toBe(at('b-right').y)
  expect(at('b-left').x).toBeLessThan(at('b-right').x)
  expect(at('b-right').x).toBeLessThan(at('a').x)
  expect(at('a').x).toBeLessThan(at('last').x)
  expect(at('b-left').y).toBeLessThan(at('a').y)
  expect(result.untouched).toEqual(['orphan', 'script', 'upload'])
  expect(at('upload').x).toBe(0)
  expect(plan(nodes, { mode: 'script', columns: 8 })).toEqual(result)
})

it.each([false, true])('script skips empty shots between linked rows and stays idempotent with selectedOnly=%s', selectedOnly => {
  const nodes = [scriptNode(['s1', 's2', 's3', 's4']),
    linked('last', 's4', 'first', { w: 300, h: 200 }),
    linked('first', 's1', 'first', { w: 300, h: 200, y: 1000 })]
  const extra = { mode: 'script' as const, nodeIds: selectedOnly ? ['first', 'last'] : undefined }
  const result = plan(nodes, extra)
  const placed = applyPlan(nodes, result.ops)
  const first = placed.find(node => node.nodeId === 'first')!
  const last = placed.find(node => node.nodeId === 'last')!
  expect(first.h).toBe(213)
  expect(last.y - first.y).toBe(first.h + NODE_GAP)
  expect(plan(placed, extra).ops).toEqual([])
})

it('script frames use caller titles for untitled scripts and reuse exact titles', () => {
  const script = { ...scriptNode(), title: null }
  const result = plan([script, frame('f', titles.untitledScript), linked('a', 'shot-a', 'first')], { mode: 'script' })
  expect(result.groups[0]).toMatchObject({ title: titles.untitledScript, frameId: 'f' })
})

it.each(['category', 'script', 'inPlace'] as const)('is idempotent in %s for auto and one column, on whole canvas or selection', mode => {
  for (const columns of ['auto', 1] as const) for (const selection of [false, true]) {
    if (mode === 'inPlace' && !selection) continue
    const members = [linked('a', 'shot-a', 'video', { kind: 'video', w: 200, h: 112, x: 0, y: 500 }),
      linked('b', 'shot-b', 'first', { w: 213, h: 320, x: 800, y: 0 }),
      linked('c', 'shot-b', 'first', { x: 0, y: 0 })]
    const nodes = [scriptNode(), ...members, node('fixed', { x: -3000, y: -3000 })]
    const extra = { mode, columns, nodeIds: selection ? members.map(node => node.nodeId) : undefined }
    const first = plan(nodes, extra)
    expect(first.ops.length).toBeGreaterThan(0)
    const placed = applyPlan(nodes, first.ops)
    expect(plan(placed, extra).ops).toEqual([])
  }
})

it('in place requires a selection and keeps members in each innermost frame while growing ancestors', () => {
  expect(plan([node('a'), node('b')], { mode: 'inPlace' }).insufficientSelection).toBe(true)
  expect(plan([node('a')], { mode: 'inPlace', nodeIds: ['a'] }).insufficientSelection).toBe(true)
  const nodes = [frame('outer', 'Outer', { x: -100, y: -100, w: 1600, h: 1000 }),
    frame('one', 'One', { x: 0, y: 0, w: 600, h: 600, frameId: 'outer' }),
    frame('two', 'Two', { x: 800, y: 0, w: 600, h: 600, frameId: 'outer' }),
    node('a', { x: 24, y: 56, frameId: 'one' }), node('b', { x: 100, y: 100, frameId: 'one' }),
    node('c', { x: 824, y: 56, frameId: 'two' }), node('d', { x: 900, y: 100, frameId: 'two' })]
  const extra = { mode: 'inPlace' as const, columns: 1 as const, nodeIds: ['a', 'b', 'c', 'd'] }
  const result = plan(nodes, extra)
  expect(result.ops.some(op => op.op === 'frame.create')).toBe(false)
  const placed = applyPlan(nodes, result.ops)
  for (const id of extra.nodeIds) expect(placed.find(node => node.nodeId === id)!.frameId).toBe(nodes.find(node => node.nodeId === id)!.frameId)
  for (const group of result.groups) {
    const frame = placed.find(node => node.nodeId === group.frameId)!
    expect(group).toMatchObject({ x: frame.x, y: frame.y, w: frame.w, h: frame.h })
  }
  expect(growFrames(placed)).toEqual([])
  expect(plan(placed, extra).ops).toEqual([])
})

it.each([200, 1000])('in place avoids an unselected sibling of height %s, grows its frame if needed, and stays idempotent', h => {
  const nodes = [frame('f', 'Frame', { w: 2000, h: 1400 }),
    node('a', { kind: 'text', x: 100, y: 100, w: 300, h: 200, frameId: 'f' }),
    node('c', { kind: 'text', x: 100, y: 400, w: 300, h, frameId: 'f' }),
    node('b', { kind: 'text', x: 100, y: 900, w: 300, h: 200, frameId: 'f' })]
  const extra = { mode: 'inPlace' as const, nodeIds: ['a', 'b'], columns: 1 as const }
  const result = plan(nodes, extra)
  const placed = applyPlan(nodes, result.ops)
  const container = placed.find(node => node.nodeId === 'f')!
  const a = placed.find(node => node.nodeId === 'a')!
  const b = placed.find(node => node.nodeId === 'b')!
  const c = placed.find(node => node.nodeId === 'c')!
  expect(a).toEqual(nodes[1])
  expect(c).toEqual(nodes[2])
  expect(b).toMatchObject({ x: 100, y: c.y + c.h + NODE_GAP, frameId: 'f' })
  expect(overlap(b, c)).toBe(false)
  expect(b.x + b.w).toBeLessThanOrEqual(container.x + container.w - 24)
  expect(b.y + b.h).toBeLessThanOrEqual(container.y + container.h - 24)
  expect(container).toMatchObject({ x: 0, y: 0, w: 2000, h: Math.max(1400, b.y + b.h + 24) })
  expect(growFrames(placed)).toEqual([])
  expect(plan(placed, extra).ops).toEqual([])
})

it('in place shifts a complete row past a nested frame without moving the frame', () => {
  const members = ['a', 'b', 'c', 'd'].map((id, index) => node(id, {
    kind: 'text', x: 100 + index % 2 * 400, y: index < 2 ? 100 : 1000, w: 300, h: 200, frameId: 'f',
  }))
  const nodes = [frame('f', 'Frame', { w: 2000, h: 1600 }),
    frame('nested', 'Nested', { x: 500, y: 400, w: 600, h: 300, frameId: 'f' }), ...members]
  const extra = { mode: 'inPlace' as const, nodeIds: [...members.map(node => node.nodeId), 'nested'], columns: 2 as const }
  const result = plan(nodes, extra)
  const placed = applyPlan(nodes, result.ops)
  const at = (id: string) => placed.find(node => node.nodeId === id)!
  expect(at('nested')).toEqual(nodes[1])
  expect(at('a')).toMatchObject({ x: 100, y: 100, frameId: 'f' })
  expect(at('b')).toMatchObject({ x: 480, y: 100, frameId: 'f' })
  for (const id of ['c', 'd']) {
    expect(at(id).y).toBe(at('nested').y + at('nested').h + NODE_GAP)
    expect(at(id).frameId).toBe('f')
    expect(overlap(at(id), at('nested'))).toBe(false)
  }
  expect(plan(placed, extra).ops).toEqual([])
})

it('in place on open canvas avoids unselected nodes and anchors at the current top-left', () => {
  const nodes = [node('a'), node('b', { x: 50, y: 50 }), node('fixed', { x: 0, y: 400 })]
  const result = plan(nodes, { mode: 'inPlace', nodeIds: ['a', 'b'], columns: 1 })
  const placed = applyPlan(nodes, result.ops)
  expect(placed[0]!.x).toBe(0)
  expect(placed[0]!.y).toBe(800)
  expect(placed[2]).toEqual({ ...nodes[2]!, frameId: null })
  expect(plan(placed, { mode: 'inPlace', nodeIds: ['a', 'b'], columns: 1 }).ops).toEqual([])
})

it('digest is stable and detects outcome changes while accepting edits with identical target ops', () => {
  const nodes = [frame('f', 'Art', { w: 1000, h: 1000 }), node('a', { category: 'Art', x: 500, y: 500 })]
  const before = plan(nodes, { columns: 1 })
  expect(organizePlanDigest(before)).toBe(organizePlanDigest(plan(structuredClone(nodes), { columns: 1 })))
  expect(organizePlanDigest(before)).toBe(organizePlanDigest({ ...before, ops: before.ops.map(op => Object.fromEntries(Object.entries(op).reverse()) as CanvasOp) }))
  expect(organizePlanDigest(before)).toBe(organizePlanDigest(plan([nodes[0]!, { ...nodes[1]!, x: 600 }], { columns: 1 })))
  const placed = applyPlan(nodes, before.ops)
  const empty = organizePlanDigest(plan(placed))
  expect(organizePlanDigest(plan(placed.map(node => node.nodeId === 'a' ? { ...node, x: node.x + 10 } : node)))).not.toBe(empty)
  expect(organizePlanDigest(plan(nodes.map(node => node.nodeId === 'a' ? { ...node, category: 'New' } : node)))).not.toBe(organizePlanDigest(before))
  const shots = [scriptNode(), linked('a', 'shot-a', 'first'), linked('b', 'shot-b', 'first')]
  expect(organizePlanDigest(plan(shots, { mode: 'script' }))).not.toBe(organizePlanDigest(plan([scriptNode(['shot-a', 'shot-b']), ...shots.slice(1)], { mode: 'script' })))
})

it('limit counts distinct changed nodes including frames, and empty-frame removal is optional', () => {
  const nodes = Array.from({ length: 1001 }, (_, index) => node(`n${index}`, { w: 200, h: 200 }))
  expect(plan(nodes, { mode: 'inPlace', nodeIds: nodes.map(node => node.nodeId) }).tooLarge).toEqual({ count: 1001, limit: 1000 })
  expect(plan([frame('f', 'Empty')], { removeEmptyFrames: false }).ops).toEqual([])
})

it('script groups with identical titles keep distinct frames on repeated plans', () => {
  const nodes = [scriptNode(), { ...scriptNode(), nodeId: 'script-two' },
    linked('a', 'shot-a', 'first'), linked('b', 'shot-b', 'first', { shot: { scriptNodeId: 'script-two', shotId: 'shot-b', role: 'first' } })]
  const first = plan(nodes, { mode: 'script' })
  expect(first.groups).toHaveLength(2)
  expect(new Set(first.groups.map(group => group.frameId)).size).toBe(2)
  expect(plan(applyPlan(nodes, first.ops), { mode: 'script' }).ops).toEqual([])
})

it('selected packing preserves a row when an obstacle occupies only the second column', () => {
  const members = Array.from({ length: 4 }, (_, index) => node(`member-${index}`, { category: 'Art', frameId: 'f', x: 1000 + index * 400, y: 1000 }))
  const nodes = [frame('f', 'Art', { w: 3000, h: 3000 }), node('obstacle', { x: 424, y: 56, h: 700, frameId: 'f' }), ...members]
  const extra = { nodeIds: members.map(node => node.nodeId), columns: 2 as const }
  const first = plan(nodes, extra)
  const placed = applyPlan(nodes, first.ops)
  expect(placed.find(node => node.nodeId === 'member-0')!.y).toBe(placed.find(node => node.nodeId === 'member-1')!.y)
  expect(plan(placed, extra).ops).toEqual([])
})

it('in place grows only frames containing the selection and their ancestors', () => {
  const nodes = [node('a'), node('b', { x: 100 }), frame('unrelated', 'Unrelated', { x: 5000, y: 0, w: 320, h: 200 }),
    node('outside-padding', { x: 5000, y: 0, frameId: 'unrelated' })]
  const result = plan(nodes, { mode: 'inPlace', nodeIds: ['a', 'b'] })
  expect(result.ops.every(op => op.op === 'node.layout' && ['a', 'b'].includes(op.nodeId))).toBe(true)
})

it('open-canvas in-place packing avoids frames so selection does not acquire membership', () => {
  const nodes = [node('a'), node('b', { x: 1500 }), frame('fixed', 'Fixed', { x: 0, y: 400, w: 1000, h: 600 })]
  const extra = { mode: 'inPlace' as const, nodeIds: ['a', 'b'], columns: 1 as const }
  const result = plan(nodes, extra)
  const placed = applyPlan(nodes, result.ops)
  expect(placed.find(node => node.nodeId === 'a')!.frameId).toBeNull()
  expect(placed.find(node => node.nodeId === 'b')!.frameId).toBeNull()
  expect(plan(placed, extra).ops).toEqual([])
})

it('open-canvas members avoid the final growth of other selected frame partitions', () => {
  const nodes = [frame('f', 'Frame', { w: 600, h: 600 }),
    ...Array.from({ length: 3 }, (_, index) => node(`framed-${index}`, { x: 24 + index * 100, y: 56, frameId: 'f' })),
    node('open', { x: 24, y: 680 })]
  const extra = { mode: 'inPlace' as const, nodeIds: nodes.filter(node => node.kind !== 'frame').map(node => node.nodeId), columns: 1 as const }
  const result = plan(nodes, extra)
  const placed = applyPlan(nodes, result.ops)
  expect(placed.find(node => node.nodeId === 'open')!.frameId).toBeNull()
  expect(placed.find(node => node.nodeId === 'open')!.y).toBeGreaterThanOrEqual(placed.find(node => node.nodeId === 'f')!.h + NODE_GAP)
  expect(plan(placed, extra).ops).toEqual([])
})
