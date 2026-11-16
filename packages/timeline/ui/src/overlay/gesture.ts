import type { OverlayPlacement } from '@vis/protocol'

/** Transient placement is shared by the preview and small Inspector fields, never the document. */
export function createPlacementGestures() {
  const placements = new Map<string, OverlayPlacement>()
  const listeners = new Set<() => void>()
  return {
    get: (id: string) => placements.get(id),
    set(id: string, placement?: OverlayPlacement) {
      if (placement) placements.set(id, placement)
      else placements.delete(id)
      listeners.forEach(listener => listener())
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}
export type PlacementGestures = ReturnType<typeof createPlacementGestures>
