import { ORGANIZE_LIMITS, type CanvasOp, type NodeView, type OrganizeColumns, type OrganizeMode } from '@vis/protocol'
import { FRAME_MIN_SIZE, frameMembers, NODE_GAP, growFrames, FRAME_PADDING as PADDING, FRAME_HEADER as HEADER } from './frames'
export * from './frames'

type Rect = { x: number, y: number, w: number, h: number }
export type OrganizePlan = {
  ops: CanvasOp[]
  groups: (Rect & { title: string; frameId: string | null; nodeIds: string[] })[]
  removedFrames: { nodeId: string; title: string }[]
  untouched: string[]
  insufficientSelection?: true
  tooLarge?: { count: number; limit: number }
}
export type OrganizeInput = {
  nodes: NodeView[]
  mode: OrganizeMode
  nodeIds?: string[] | undefined
  columns?: OrganizeColumns | undefined
  removeEmptyFrames: boolean
  titles: { uncategorized: string; untitledScript: string }
}

// Unified widths would stretch media; scale their height with the width instead. Clamp like fitNodeToAsset.
export const fittedHeight = (node: NodeView, width: number) => node.kind === 'image' || node.kind === 'video'
  ? Math.max(80, Math.min(4 * width, Math.round(node.h * width / node.w)))
  : node.h
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w + NODE_GAP && b.x < a.x + a.w + NODE_GAP
  && a.y < b.y + b.h + NODE_GAP && b.y < a.y + a.h + NODE_GAP

export function readingOrder(nodes: NodeView[]) {
  const rows: { top: number, members: NodeView[] }[] = []
  for (const node of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || compare(a.nodeId, b.nodeId))) {
    const row = rows.at(-1)
    // Half a gap absorbs hand-placement drift without merging the grid's separate rows.
    if (!row || node.y - row.top > NODE_GAP / 2) rows.push({ top: node.y, members: [node] })
    else row.members.push(node)
  }
  return rows.flatMap(row => row.members.sort((a, b) => a.x - b.x || compare(a.nodeId, b.nodeId)))
}

/** Sort by name within strongly connected components, keeping upstream components first outside cycles. */
function categoryOrder(categories: string[], dependencies: Map<string, Set<string>>) {
  const indices = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const active = new Set<string>()
  const ordered: string[] = []
  let index = 0
  const visit = (category: string) => {
    indices.set(category, index)
    low.set(category, index++)
    stack.push(category)
    active.add(category)
    for (const source of [...dependencies.get(category)!].sort(compare)) {
      if (!indices.has(source)) {
        visit(source)
        low.set(category, Math.min(low.get(category)!, low.get(source)!))
      } else if (active.has(source)) low.set(category, Math.min(low.get(category)!, indices.get(source)!))
    }
    if (low.get(category) !== indices.get(category)) return
    const component: string[] = []
    let member: string
    do {
      member = stack.pop()!
      active.delete(member)
      component.push(member)
    } while (member !== category)
    ordered.push(...component.sort(compare))
  }
  for (const category of categories.sort(compare)) if (!indices.has(category)) visit(category)
  return ordered
}

const media = (node: NodeView) => node.kind === 'image' || node.kind === 'video'
function sizes(members: NodeView[]) {
  const width = Math.ceil(Math.max(320, ...members.filter(media).map(node => node.w)))
  return members.map(node => ({ w: media(node) ? width : node.w, h: fittedHeight(node, width) }))
}

function grid(members: NodeView[], columns: number) {
  const dimensions = sizes(members)
  const widths = Array.from({ length: columns }, (_, column) => Math.max(0, ...dimensions.filter((_, index) => index % columns === column).map(size => size.w)))
  const heights = Array.from({ length: Math.ceil(members.length / columns) }, (_, row) => Math.max(...dimensions.slice(row * columns, (row + 1) * columns).map(size => size.h)))
  const offset = (values: number[], index: number) => values.slice(0, index).reduce((sum, value) => sum + value + NODE_GAP, 0)
  return {
    columns,
    w: widths.reduce((sum, value) => sum + value, 0) + (columns - 1) * NODE_GAP,
    h: heights.reduce((sum, value) => sum + value, 0) + (heights.length - 1) * NODE_GAP,
    cells: dimensions.map((size, index) => ({ ...size, x: offset(widths, index % columns), y: offset(heights, Math.floor(index / columns)) })),
  }
}

export function organizeGrid(members: NodeView[], columns: OrganizeColumns = 'auto') {
  if (columns !== 'auto') return grid(members, Math.min(columns, members.length))
  let best = grid(members, 1)
  const distance = (box: Rect | { w: number; h: number }) => Math.abs(Math.log(box.w / box.h) - Math.log(4 / 3))
  for (let count = 2; count <= Math.min(ORGANIZE_LIMITS.columns, members.length); count++) {
    const candidate = grid(members, count)
    if (distance(candidate) < distance(best) - 1e-12) best = candidate
  }
  return best
}

export function organizeChangedCount(plan: OrganizePlan) {
  return new Set(plan.ops.map(op => op.op === 'frame.create' ? op.tempId : 'nodeId' in op ? op.nodeId : '')).size
}

function bounded(plan: OrganizePlan): OrganizePlan {
  const count = organizeChangedCount(plan)
  return count > ORGANIZE_LIMITS.nodes ? { ...plan, tooLarge: { count, limit: ORGANIZE_LIMITS.nodes } } : plan
}

/** Canonical tuples keep the digest independent of object insertion order in either runtime. */
export function organizePlanDigest(plan: OrganizePlan) {
  const serialized = JSON.stringify(plan.ops.map(op => {
    switch (op.op) {
      case 'frame.create': return [op.op, op.tempId, op.title, op.x, op.y, op.w, op.h]
      case 'node.layout': return [op.op, op.nodeId, op.x ?? null, op.y ?? null, op.w ?? null, op.h ?? null, op.z ?? null]
      case 'node.delete': return [op.op, op.nodeId]
      default: throw new Error('Unexpected organize operation')
    }
  }))
  let hash = 0x811c9dc5
  for (let index = 0; index < serialized.length; index++) hash = Math.imul(hash ^ serialized.charCodeAt(index), 0x01000193)
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function planOrganize(input: OrganizeInput): OrganizePlan {
  if (input.mode === 'inPlace') return bounded(inPlace(input))
  return bounded(partitions(input))
}

function scriptGrid(members: NodeView[], script: NodeView) {
  const content = script.slots.find(slot => slot.slotKey === 'main')?.content
  const shots = content?.type === 'script' ? content.doc.shots.map(shot => shot.id) : []
  const memberShots = new Set(members.map(node => node.shot!.shotId))
  const documentedShots = new Set(shots)
  const rows = [...shots.filter(id => memberShots.has(id)), ...[...memberShots].filter(id => !documentedShots.has(id)).sort(compare)]
  const roles = (['first', 'last', 'video', 'previz'] as const).filter(role => members.some(node => node.shot!.role === role))
  const dimensions = sizes(members)
  const cells = rows.flatMap((shot, row) => roles.map((role, column) => ({
    row, column, indices: members.flatMap((node, index) => node.shot!.shotId === shot && node.shot!.role === role ? [index] : []),
  })))
  const widths = roles.map((_, column) => Math.max(0, ...cells.filter(cell => cell.column === column).map(cell => cell.indices.reduce((sum, index) => sum + dimensions[index]!.w, 0) + Math.max(0, cell.indices.length - 1) * NODE_GAP)))
  const heights = rows.map((_, row) => Math.max(0, ...cells.filter(cell => cell.row === row).flatMap(cell => cell.indices.map(index => dimensions[index]!.h))))
  const offset = (values: number[], index: number) => values.slice(0, index).reduce((sum, value) => sum + value + NODE_GAP, 0)
  const positions = new Map<number, Rect>()
  for (const cell of cells) {
    let x = offset(widths, cell.column)
    for (const index of cell.indices) {
      positions.set(index, { x, y: offset(heights, cell.row), ...dimensions[index]! })
      x += dimensions[index]!.w + NODE_GAP
    }
  }
  return { w: widths.reduce((sum, value) => sum + value, 0) + Math.max(0, widths.length - 1) * NODE_GAP,
    h: heights.reduce((sum, value) => sum + value, 0) + Math.max(0, heights.length - 1) * NODE_GAP,
    cells: members.map((_, index) => positions.get(index)!) }
}

function partitions({ nodes, mode, nodeIds, columns, removeEmptyFrames, titles }: OrganizeInput): OrganizePlan {
  const categoryOf = (node: NodeView) => mode === 'script'
    ? nodes.find(script => script.nodeId === node.shot?.scriptNodeId)!.nodeId : node.category ?? titles.uncategorized
  // These aliases only recognize persisted titles; every emitted title comes from the caller.
  const otherUncategorized = titles.uncategorized === 'Uncategorized' ? '\u672a\u5206\u7c7b' : 'Uncategorized'
  const selected = nodeIds?.length ? new Set(nodeIds) : undefined
  const visible = nodes.filter(node => node.purpose !== 'working')
  const candidates = visible.filter(node => node.kind !== 'frame' && (!selected || selected.has(node.nodeId)))
  const items = mode === 'script' ? candidates.filter(node => node.shot && nodes.some(script => script.nodeId === node.shot!.scriptNodeId && script.kind === 'script')) : candidates
  const untouched = candidates.filter(node => !items.includes(node)).map(node => node.nodeId).sort(compare)
  const byCategory = new Map<string, NodeView[]>()
  for (const node of items) {
    const category = categoryOf(node)
    byCategory.set(category, [...(byCategory.get(category) ?? []), node])
  }
  const byId = new Map(visible.map(node => [node.nodeId, node]))
  const dependencies = new Map([...byCategory.keys()].map(category => [category, new Set<string>()]))
  for (const node of items) {
    for (const id of [...(node.inputs ?? []), ...node.slots.flatMap(slot => slot.source?.inputNodeIds ?? [])]) {
      const source = byId.get(id)
      if (!source || source.kind === 'frame') continue
      if (mode === 'script') continue
      const category = categoryOf(source)
      if (category !== categoryOf(node) && byCategory.has(category)) dependencies.get(categoryOf(node))!.add(category)
    }
  }
  const frames = visible.filter(node => node.kind === 'frame').sort((a, b) => compare(a.nodeId, b.nodeId))
  const usedIds = new Set(nodes.map(node => node.nodeId))
  let frameIndex = 0
  const claimed = new Set<string>()
  const groups = categoryOrder([...byCategory.keys()], dependencies).map(category => {
    const members = readingOrder(byCategory.get(category)!)
    const script = mode === 'script' ? nodes.find(node => node.nodeId === category)! : undefined
    const title = script ? script.title || titles.untitledScript : category
    // After switching languages, reuse the other language's uncategorized frame without claiming a frame assigned to an existing category.
    const frame = (script ? frames.find(node => !claimed.has(node.nodeId) && node.frame?.title === title && members.some(member => member.frameId === node.nodeId)) : undefined)
      ?? frames.find(node => !claimed.has(node.nodeId) && node.frame?.title === title)
      ?? (mode === 'category' && category === titles.uncategorized && !byCategory.has(otherUncategorized) ? frames.find(node => !claimed.has(node.nodeId) && node.frame?.title === otherUncategorized) : undefined)
    const layout = script ? scriptGrid(members, script) : organizeGrid(members, columns)
    const w = Math.max(frame?.w ?? FRAME_MIN_SIZE.w, layout.w + 2 * PADDING)
    let frameId = frame?.nodeId
    if (!frameId) {
      do { frameId = `organize-frame-${frameIndex++}` } while (usedIds.has(frameId))
      usedIds.add(frameId)
    }
    claimed.add(frameId)
    return {
      category: title, members, frame, layout,
      frameId,
      anchored: !!selected && !!frame && frameMembers(frame.nodeId, nodes).some(node => !selected.has(node.nodeId)),
      w,
      h: Math.max(frame?.h ?? FRAME_MIN_SIZE.h, HEADER + layout.h + PADDING),
    }
  })
  const targets = new Set(groups.map(group => group.frameId))
  const itemIds = new Set(items.map(node => node.nodeId))
  const movingTargets = new Set(groups.filter(group => !group.anchored).map(group => group.frameId))
  const removable = new Map<string, boolean>()
  const emptied = (frameId: string, visiting = new Set<string>()): boolean => {
    if (targets.has(frameId) || visiting.has(frameId)) return false
    if (removable.has(frameId)) return removable.get(frameId)!
    const path = new Set([...visiting, frameId])
    const members = frameMembers(frameId, nodes)
    const moved = members.some(node => itemIds.has(node.nodeId) || movingTargets.has(node.nodeId))
    const empty = (!selected || moved) && members.every(node => itemIds.has(node.nodeId)
      || node.kind === 'frame' && node.purpose !== 'working' && (movingTargets.has(node.nodeId) || emptied(node.nodeId, path)))
    removable.set(frameId, empty)
    return empty
  }
  const removedFrames = frames.filter(frame => emptied(frame.nodeId)).map(frame => ({ nodeId: frame.nodeId, title: frame.frame?.title ?? frame.nodeId }))
  const removals: CanvasOp[] = removeEmptyFrames ? removedFrames.map(frame => ({ op: 'node.delete', nodeId: frame.nodeId })) : []
  if (!groups.length) {
    return { ops: removals, groups: [], removedFrames, untouched }
  }

  const movableFrames = new Set(groups.filter(group => !group.anchored).map(group => group.frameId))
  const deleted = new Set(removals.map(op => 'nodeId' in op ? op.nodeId : ''))
  const fixed = visible.filter(node => !deleted.has(node.nodeId) && (node.kind === 'frame' ? !movableFrames.has(node.nodeId) : !itemIds.has(node.nodeId)))
  const origin = {
    x: Math.round(Math.min(...items.map(node => node.x), ...groups.flatMap(group => group.frame ? [group.frame.x] : []))),
    y: Math.round(Math.min(...items.map(node => node.y), ...groups.flatMap(group => group.frame ? [group.frame.y] : []))),
  }
  const placements = new Map<string, Rect>()
  const layouts = new Map<string, Rect>()
  const ancestors = (frame: NodeView) => {
    const ids = new Set<string>()
    let id = frame.frameId
    while (id && !ids.has(id) && id !== frame.nodeId) {
      ids.add(id)
      id = byId.get(id)?.frameId
    }
    return ids
  }
  const pack = (group: typeof groups[number], x: number, y: number, obstacles: Rect[]) => {
    let bottom = y + group.h - PADDING
    let shift = 0
    const rows = [...new Set(group.layout.cells.map(cell => cell.y))].sort((a, b) => a - b)
    for (const row of rows) {
      const members = group.members.flatMap((node, index) => group.layout.cells[index]!.y === row ? [{ node, cell: group.layout.cells[index]! }] : [])
      const positions = members.map(({ cell }) => ({ ...cell, x: x + PADDING + cell.x, y: y + HEADER + cell.y + shift }))
      for (;;) {
        const collisions = obstacles.filter(obstacle => positions.some(position => overlaps(position, obstacle)))
        if (!collisions.length) break
        const nextY = Math.ceil(Math.max(...collisions.map(rect => rect.y + rect.h + NODE_GAP)))
        const delta = nextY - positions[0]!.y
        shift += delta
        for (const position of positions) position.y += delta
      }
      for (const [index, { node }] of members.entries()) {
        const position = positions[index]!
        placements.set(node.nodeId, position)
        obstacles.push(position)
        bottom = Math.max(bottom, position.y + position.h)
      }
    }
    layouts.set(group.frameId, { x, y, w: group.w, h: Math.max(group.h, bottom + PADDING - y) })
  }
  // With partial selection, original frames cannot take unselected members along; arrange them in place first, then find space for other partitions.
  for (const group of groups.filter(group => group.anchored)) {
    const parents = ancestors(group.frame!)
    pack(group, group.frame!.x, group.frame!.y, [
      ...fixed.filter(node => node.nodeId !== group.frameId && !parents.has(node.nodeId)),
      ...[...layouts].filter(([id]) => !parents.has(id)).map(([, rect]) => rect), ...placements.values(),
    ])
  }
  const affectedParents = new Set(groups.filter(group => group.anchored).flatMap(group => [...ancestors(group.frame!)]))
  if (affectedParents.size) {
    const membership = new Map(groups.filter(group => group.anchored).flatMap(group => group.members.map(node => [node.nodeId, group.frameId] as const)))
    const prospective = visible.map(node => ({ ...node, ...layouts.get(node.nodeId), ...placements.get(node.nodeId), frameId: membership.get(node.nodeId) ?? node.frameId }))
    for (const op of growFrames(prospective)) if (affectedParents.has(op.nodeId)) {
      layouts.set(op.nodeId, { x: op.x!, y: op.y!, w: op.w!, h: op.h! })
    }
  }
  let cursor = origin.x
  for (const group of groups.filter(group => !group.anchored)) {
    const bounds = { x: cursor, y: origin.y, w: group.w, h: group.h }
    const obstacles = [...fixed, ...layouts.values()]
    for (;;) {
      const collisions = obstacles.filter(obstacle => overlaps(bounds, obstacle))
      if (!collisions.length) break
      bounds.x = Math.ceil(Math.max(...collisions.map(rect => rect.x + rect.w + NODE_GAP)))
    }
    pack(group, bounds.x, bounds.y, [])
    cursor = bounds.x + bounds.w + NODE_GAP
  }
  const ops: CanvasOp[] = []
  for (const group of groups) {
    const rect = layouts.get(group.frameId)!
    if (!group.frame) ops.push({ op: 'frame.create', tempId: group.frameId, title: group.category, ...rect })
    else if (['x', 'y', 'w', 'h'].some(key => rect[key as keyof Rect] !== group.frame![key as keyof Rect])) {
      ops.push({ op: 'node.layout', nodeId: group.frameId, ...rect })
    }
  }
  for (const node of frames) {
    if (groups.some(group => group.frameId === node.nodeId)) continue
    const rect = layouts.get(node.nodeId)
    if (rect) ops.push({ op: 'node.layout', nodeId: node.nodeId, ...rect })
  }
  // Place frames first and write node positions last; the server computes frameId from final center points.
  for (const group of groups) for (const node of group.members) {
    const { x, y, w, h } = placements.get(node.nodeId)!
    if (node.x !== x || node.y !== y || node.w !== w || node.h !== h) ops.push({ op: 'node.layout', nodeId: node.nodeId, x, y, w, ...(node.h !== h ? { h } : {}) })
  }
  ops.push(...removals)
  return { ops, removedFrames, untouched, groups: groups.map(group => ({ title: group.category, frameId: group.frameId,
    nodeIds: group.members.map(node => node.nodeId), ...layouts.get(group.frameId)! })) }
}

function inPlace({ nodes, nodeIds, columns }: OrganizeInput): OrganizePlan {
  const selected = new Set(nodeIds)
  const items = nodes.filter(node => selected.has(node.nodeId) && node.kind !== 'frame' && node.purpose !== 'working')
  const plan: OrganizePlan = { ops: [], groups: [], removedFrames: [], untouched: [] }
  if (items.length < 2) return { ...plan, insufficientSelection: true }
  const affectedFrames = new Set<string>()
  for (const member of items) {
    let id = member.frameId
    const visiting = new Set<string>()
    while (id && !visiting.has(id)) {
      visiting.add(id)
      affectedFrames.add(id)
      id = nodes.find(node => node.nodeId === id)?.frameId
    }
  }
  const partitions = new Map<string | null, NodeView[]>()
  for (const node of items) {
    const id = node.frameId ?? null
    partitions.set(id, [...(partitions.get(id) ?? []), node])
  }
  const placements = new Map<string, Rect>()
  // Grow framed partitions first so open-canvas members avoid their final bounds and cannot acquire membership.
  for (const [frameId, members] of [...partitions].sort(([a], [b]) => a === b ? 0 : a === null ? 1 : b === null ? -1 : compare(a, b))) {
    const ordered = readingOrder(members)
    const layout = organizeGrid(ordered, columns)
    const frame = nodes.find(node => node.nodeId === frameId)
    const x = Math.round(Math.max(frame ? frame.x + PADDING : -Infinity, Math.min(...members.map(node => node.x))))
    let y = Math.round(Math.max(frame ? frame.y + HEADER : -Infinity, Math.min(...members.map(node => node.y))))
    if (!frame) {
      const bounds = { x, y, w: layout.w, h: layout.h }
      const prospective = nodes.map(node => ({ ...node, ...placements.get(node.nodeId) }))
      const growth = new Map(growFrames(prospective).filter(op => affectedFrames.has(op.nodeId)).map(op => [op.nodeId, { x: op.x!, y: op.y!, w: op.w!, h: op.h! }]))
      const openIds = new Set(members.map(node => node.nodeId))
      const fixed = prospective.filter(node => node.purpose !== 'working' && !openIds.has(node.nodeId)).map(node => ({ ...node, ...growth.get(node.nodeId) }))
      for (;;) {
        const collisions = fixed.filter(node => overlaps(bounds, node))
        if (!collisions.length) break
        bounds.y = Math.ceil(Math.max(...collisions.map(node => node.y + node.h + NODE_GAP)))
      }
      y = bounds.y
    }
    const obstacles: Rect[] = frame ? frameMembers(frame.nodeId, nodes)
      .filter(node => node.purpose !== 'working' && (node.kind === 'frame' || !selected.has(node.nodeId))) : []
    let shift = 0
    for (const row of [...new Set(layout.cells.map(cell => cell.y))].sort((a, b) => a - b)) {
      const members = ordered.flatMap((node, index) => layout.cells[index]!.y === row ? [{ node, cell: layout.cells[index]! }] : [])
      const positions = members.map(({ cell }) => ({ ...cell, x: x + cell.x, y: y + cell.y + shift }))
      for (;;) {
        const collisions = obstacles.filter(obstacle => positions.some(position => overlaps(position, obstacle)))
        if (!collisions.length) break
        const nextY = Math.ceil(Math.max(...collisions.map(rect => rect.y + rect.h + NODE_GAP)))
        const delta = nextY - positions[0]!.y
        shift += delta
        for (const position of positions) position.y += delta
      }
      for (const [index, { node }] of members.entries()) {
        const position = positions[index]!
        placements.set(node.nodeId, position)
        obstacles.push(position)
      }
    }
    plan.groups.push({ title: frame?.frame?.title ?? '', frameId, nodeIds: ordered.map(node => node.nodeId), x, y, w: layout.w, h: layout.h + shift })
  }
  const prospective = nodes.map(node => ({ ...node, ...placements.get(node.nodeId) }))
  plan.ops.push(...growFrames(prospective).filter(op => affectedFrames.has(op.nodeId)))
  for (const group of plan.groups) {
    const frame = nodes.find(node => node.nodeId === group.frameId)
    if (!frame) continue
    const growth = plan.ops.find(op => op.op === 'node.layout' && op.nodeId === frame.nodeId)
    const rect = growth?.op === 'node.layout' ? growth : frame
    Object.assign(group, { x: rect.x, y: rect.y, w: rect.w, h: rect.h })
  }
  for (const group of plan.groups) for (const id of group.nodeIds) {
    const node = nodes.find(node => node.nodeId === id)!
    const rect = placements.get(id)!
    if (node.x !== rect.x || node.y !== rect.y || node.w !== rect.w || node.h !== rect.h) plan.ops.push({ op: 'node.layout', nodeId: id, ...rect })
  }
  return plan
}
