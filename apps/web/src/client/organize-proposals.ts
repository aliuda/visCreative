import type { MethodResult, OrganizeProposal } from '@vis/protocol'
import { useEffect, useMemo, useState } from 'react'
import type { SpaceConnection } from './space'

const EMPTY: OrganizeProposal[] = []

/** Pending is queried separately so older open suggestions survive the bounded history list. */
export function useOrganizeProposals(conn: SpaceConnection, spaceId: string | undefined, ready: boolean) {
  const [cache, setCache] = useState<{ spaceId: string | undefined; proposals: OrganizeProposal[] }>({ spaceId, proposals: EMPTY })
  useEffect(() => {
    setCache({ spaceId, proposals: EMPTY })
    if (!ready || !spaceId) return
    let active = true
    let reading = false
    let dirty = false
    const refresh = async () => {
      if (reading) { dirty = true; return }
      reading = true
      try {
        do {
          dirty = false
          const [pending, history] = await Promise.all([
            conn.rpc.call<MethodResult<'canvas.organize.proposals'>>('canvas.organize.proposals', { status: 'pending' }),
            conn.rpc.call<MethodResult<'canvas.organize.proposals'>>('canvas.organize.proposals', { status: 'all' }),
          ])
          // An event during either read invalidates the pair, including a terminal state in just one response.
          if (active && !dirty) {
            const ids = new Set(pending.proposals.map(proposal => proposal.proposalId))
            setCache({ spaceId, proposals: [...pending.proposals, ...history.proposals.filter(proposal => !ids.has(proposal.proposalId) && proposal.status !== 'pending')] })
          }
        } while (active && dirty)
      } finally { reading = false }
    }
    const queue = () => { void refresh().catch(() => {}) }
    // SpaceConnection publishes persistent events only after its seq deduplication.
    const unsubscribe = conn.onEvent?.(event => { if (event.type === 'canvas.organizeProposalChanged') queue() })
    queue()
    return () => { active = false; unsubscribe?.() }
  }, [conn, spaceId, ready])
  const proposals = ready && cache.spaceId === spaceId ? cache.proposals : EMPTY
  const pending = useMemo(() => proposals.filter(proposal => proposal.status === 'pending'), [proposals])
  const byId = useMemo(() => new Map(proposals.map(proposal => [proposal.proposalId, proposal])), [proposals])
  return { proposals, pending, byId }
}
