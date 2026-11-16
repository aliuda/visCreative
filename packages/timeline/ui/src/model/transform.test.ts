import { describe, expect, it, vi } from 'vitest'
import type { TimelineClip, TimelineDoc } from '@vis/protocol'
import { applyClipTransform } from './transform'

const clip: TimelineClip = { id: 'clip', startMs: 0, inMs: 1000, outMs: 5000, speed: 2, source: { nodeId: 'source', assetVersionId: 'asset' }, volume: 1, fadeInMs: 0, fadeOutMs: 0 }
const doc: TimelineDoc = { version: 1, tracks: [{ id: 'main', kind: 'video', volume: 1, muted: false, clips: [clip] }] }

describe('transform commit refusals', () => {
  it('returns conflict without attempting a document edit', () => {
    const edit = vi.fn()
    expect(applyClipTransform({ doc, edit, conflict: { theirs: doc, revision: 2 } }, clip)).toBe('conflict')
    expect(edit).not.toHaveBeenCalled()
  })
  it('returns validation and missing-clip failures without attempting an edit', () => {
    const edit = vi.fn()
    expect(applyClipTransform({ doc, edit, conflict: null }, { ...clip, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } })).toBe('limit')
    expect(applyClipTransform({ doc, edit, conflict: null }, { ...clip, id: 'missing' })).toBe('missing')
    expect(edit).not.toHaveBeenCalled()
  })
  it('returns a draft refusal and sends a successful transform through one immediate edit', () => {
    const edit = vi.fn().mockReturnValue('captions')
    const next = { ...clip, crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } }
    expect(applyClipTransform({ doc, edit, conflict: null }, next)).toBe('captions')
    expect(edit).toHaveBeenCalledOnce()
    expect(edit.mock.calls[0]![1]).toEqual({ immediate: true })
    edit.mockReturnValue(undefined)
    expect(applyClipTransform({ doc, edit, conflict: null }, next)).toBeUndefined()
  })
})
