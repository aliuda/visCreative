import type { CropRect } from '@vis/protocol'
import { clamp, fitCrop, round } from './keys'

export type CropHandle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
export const cropHandles: readonly CropHandle[] = ['move', 'nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export function gestureCrop(crop: CropRect, handle: CropHandle, dx: number, dy: number, aspect?: number): CropRect {
  if (handle === 'move') return { ...crop, x: round(clamp(crop.x + dx, 0, 1 - crop.width)), y: round(clamp(crop.y + dy, 0, 1 - crop.height)) }
  let left = crop.x
  let top = crop.y
  let right = crop.x + crop.width
  let bottom = crop.y + crop.height
  if (handle.includes('w')) left = clamp(left + dx, 0, right - 0.05)
  if (handle.includes('e')) right = clamp(right + dx, left + 0.05, 1)
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - 0.05)
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + 0.05, 1)
  if (aspect) {
    let width = right - left
    if (handle === 'n' || handle === 's' || (handle.length === 2 && Math.abs(dy * aspect) > Math.abs(dx))) width = (bottom - top) * aspect
    width = clamp(width, Math.max(0.05, 0.05 * aspect), Math.min(1, aspect))
    const height = width / aspect
    left = handle.includes('w') ? crop.x + crop.width - width : handle.includes('e') ? crop.x : crop.x + (crop.width - width) / 2
    top = handle.includes('n') ? crop.y + crop.height - height : handle.includes('s') ? crop.y : crop.y + (crop.height - height) / 2
    right = left + width
    bottom = top + height
  }
  return fitCrop({ x: left, y: top, width: right - left, height: bottom - top }, aspect)
}
