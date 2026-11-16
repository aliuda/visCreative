import type { TimelineClip } from '@vis/protocol'
import type { TimelineDraft } from '../types'
import { updateClip, type EditReason } from './edit'

export type TransformRefusal = EditReason | 'conflict'

export function applyClipTransform(draft: Pick<TimelineDraft, 'doc' | 'conflict' | 'edit'>, clip: TimelineClip): TransformRefusal | undefined {
  if (draft.conflict) return 'conflict'
  const result = updateClip(draft.doc, clip.id, { crop: clip.crop ?? null, ...(clip.overlay ? { overlay: clip.overlay } : {}) })
  return result.ok ? draft.edit(result.doc, { immediate: true }) : result.reason
}
