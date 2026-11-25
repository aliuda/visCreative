import { useLayoutEffect, useRef, useState } from 'react'
import { Position, useViewport } from '@xyflow/react'
import type { NodeView } from '@vis/protocol'
import { useMessages } from '@vis/ui-kit'
import { FloatingNodeToolbar } from './FloatingNodeToolbar'
import { Icon } from './Icon'
import { messages } from './messages'
import { selectionBounds, type Align, type SnapLines } from './selectionLayout'
import { toolbarFocusIndex, toolbarOffset } from './toolbar'
import './node-toolbar.css'

export function SelectionToolbar({ selected, nodes, busy, tidyDisabled, onAlign, onDistribute, onTidy }: {
  selected: NodeView[]
  nodes: NodeView[]
  busy: boolean
  tidyDisabled: string | null
  onAlign(align: Align): void
  onDistribute(axis: 'x' | 'y'): void
  onTidy(): void
}) {
  const m = useMessages(messages)
  const { x, y, zoom } = useViewport()
  const root = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 360, h: 44 })
  useLayoutEffect(() => {
    if (!root.current) return
    const observer = new ResizeObserver(() => {
      const bounds = root.current?.getBoundingClientRect()
      if (bounds) setSize({ w: bounds.width, h: bounds.height })
    })
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [])
  const bounds = selectionBounds(selected)!
  const anchor = { ...selected[0]!, ...bounds }
  const ids = new Set(selected.map(node => node.nodeId))
  const offset = toolbarOffset(anchor.nodeId, [anchor, ...nodes.filter(node => !ids.has(node.nodeId))], zoom, size)
  const distributeDisabled = selected.length < 3 ? m.distributeNeedThree : null
  const button = (kind: Align | 'distributeHorizontal' | 'distributeVertical' | 'organize', label: string, action: () => void, reason: string | null = null) => (
    <span key={kind} title={reason ?? label}><button type="button" aria-label={label} title={reason ?? label} disabled={busy || Boolean(reason)} onClick={action}>
      <Icon kind={kind} size={16} />
    </button></span>
  )
  return <>
    {/* The shared toolbar recognizes a single-node anchor; expose group bounds to its existing obstacle placement. */}
    <div className="vis-selection-obstacle" aria-hidden="true" data-canvas-obstacle="selection" style={{
      left: x + bounds.x * zoom, top: y + (bounds.y - 27) * zoom, width: bounds.w * zoom, height: (bounds.h + 27) * zoom,
    }} />
    <FloatingNodeToolbar nodeId={selected.map(node => node.nodeId)} isVisible position={Position.Top} offset={offset} style={{ zIndex: Math.max(1, ...selected.map(node => node.z + 1)) }}>
    <div ref={root} role="toolbar" aria-label={m.selectionToolbar} className="vis-operations-toolbar vis-selection-toolbar nodrag nopan"
      onPointerDown={event => event.stopPropagation()} onKeyDown={event => {
        event.stopPropagation()
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const next = toolbarFocusIndex(event.key, buttons.indexOf(event.target as HTMLButtonElement), buttons.length)
        if (next !== undefined) { event.preventDefault(); buttons[next]?.focus() }
      }}>
      {(['alignLeft', 'alignCenter', 'alignRight', 'alignTop', 'alignMiddle', 'alignBottom'] as const).map(align => button(align, m[align], () => onAlign(align)))}
      <span className="vis-operation-divider" />
      {button('distributeHorizontal', m.distributeHorizontal, () => onDistribute('x'), distributeDisabled)}
      {button('distributeVertical', m.distributeVertical, () => onDistribute('y'), distributeDisabled)}
      <span className="vis-operation-divider" />
      {button('organize', m.tidySelection, onTidy, tidyDisabled)}
    </div>
    </FloatingNodeToolbar>
  </>
}

export function SnapGuides({ guides }: { guides: SnapLines }) {
  const { x, y, zoom } = useViewport()
  return <div className="vis-snap-guides" aria-hidden="true">
    {guides.x !== undefined ? <i style={{ left: Math.round(x + guides.x * zoom) }} /> : null}
    {guides.y !== undefined ? <b style={{ top: Math.round(y + guides.y * zoom) }} /> : null}
  </div>
}
