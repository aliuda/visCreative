import type { OrganizeProposal } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { useState } from 'react'
import { organizeProposalMessages } from './messages'

export function OrganizeProposalBar({ proposals, sessionTitles, busy, onPreview, onDismiss }: {
  proposals: readonly OrganizeProposal[]
  sessionTitles: ReadonlyMap<string, string> | undefined
  busy: boolean
  onPreview(proposal: OrganizeProposal): void
  onDismiss(proposal: OrganizeProposal): void
}) {
  const m = useMessages(organizeProposalMessages)
  const format = useFormat()
  const [choice, setChoice] = useState<{ newest: string; id: string } | null>(null)
  const newest = proposals[0]
  if (!newest) return null
  const current = choice?.newest === newest.proposalId ? proposals.find(proposal => proposal.proposalId === choice.id) ?? newest : newest
  const next = proposals[(proposals.indexOf(current) + 1) % proposals.length]!
  return <div className="vis-organize-proposal-bar" role="status" aria-label={m.bar} data-canvas-obstacle="top">
    <span className="vis-organize-proposal-text" title={current.reason}>{m.suggestion(sessionTitles?.get(current.sessionId) || m.agent, format.number(current.changed), m.mode(current.mode), current.reason)}</span>
    <button disabled={busy} onClick={() => onPreview(current)}>{m.preview}</button>
    <button disabled={busy} onClick={() => onDismiss(current)}>{m.dismiss}</button>
    {proposals.length > 1 ? <button disabled={busy} onClick={() => setChoice({ newest: newest.proposalId, id: next.proposalId })}>{m.more(format.number(proposals.length - 1))}</button> : null}
  </div>
}
