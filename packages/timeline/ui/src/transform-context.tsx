import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { TimelineClip, TimelineDoc } from '@vis/protocol'
import { initialAspectLock, type AspectLock } from './model/keys'

export type TransformEditorState = {
  cropId: string | null
  editCrop(id: string | null): void
  lockFor(clip: TimelineClip, sourceAspect?: number, outputAspect?: number): AspectLock
  setLock(id: string, lock: AspectLock | undefined): void
}
export const TransformEditorContext = createContext<TransformEditorState>({ cropId: null, editCrop() {}, lockFor: initialAspectLock, setLock() {} })
export const useTransformEditor = () => useContext(TransformEditorContext)

/** Remember accepted lock choices and geometry edits with resolved source dimensions. */
export function useTransformEditorState(cropId: string | null, editCrop: (id: string | null) => void, doc: TimelineDoc): TransformEditorState {
  const [locks, setLocks] = useState(() => new Map<string, AspectLock>())
  useEffect(() => {
    if (!locks.size) return
    const ids = new Set(doc.tracks.flatMap(track => track.clips.map(clip => clip.id)))
    setLocks(previous => {
      if (!previous.size) return previous
      const next = new Map([...previous].filter(([id]) => ids.has(id)))
      return next.size === previous.size ? previous : next
    })
  }, [doc, locks.size])
  return useMemo(() => ({ cropId, editCrop,
    lockFor: (clip: TimelineClip, sourceAspect?: number, outputAspect?: number) => locks.get(clip.id) ?? initialAspectLock(clip, sourceAspect, outputAspect),
    setLock(id: string, lock: AspectLock | undefined) {
      setLocks(previous => {
        if (previous.get(id) === lock) return previous
        const next = new Map(previous)
        if (lock === undefined) next.delete(id)
        else next.set(id, lock)
        return next
      })
    },
  }), [cropId, editCrop, locks])
}

export const useClipAspectLock = (clip: TimelineClip, sourceAspect?: number, outputAspect?: number) => useTransformEditor().lockFor(clip, sourceAspect, outputAspect)
