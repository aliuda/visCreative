import { Id, OrganizeProposal as ProposalSchema, type OrganizeProposal, type TranscriptItem } from '@vis/protocol'
import { useFormat, useMessages } from '@vis/ui-kit'
import { organizeProposalMessages } from './messages'
import { groupTranscript } from './toolGroups'

export type OrganizeProposalHost = {
  state(proposalId: string): OrganizeProposal | undefined
  open(proposalId: string): void
}
export type OrganizeReceipt = { proposalId: string; proposal?: OrganizeProposal }

/** Only successful propose receipts create cards; their current status always comes from the project cache. */
export function organizeProposalResults(items: TranscriptItem[]): Map<string, OrganizeReceipt> {
  const last = new Map<string, { itemId: string; receipt: OrganizeReceipt }>()
  for (const group of groupTranscript(items)) {
    if (group.kind === 'item') continue
    for (const pair of group.calls) {
      const name = (pair.call?.payload as { name?: string } | undefined)?.name
      if (!name || !['canvas.organize.propose', 'vis.canvas_organize_propose', 'mcp__vis__canvas_organize_propose'].includes(name)) continue
      const payload = pair.result?.payload as { text?: unknown; isError?: boolean } | undefined
      if (!pair.result || payload?.isError || typeof payload?.text !== 'string') continue
      let receipt: OrganizeReceipt | undefined
      try {
        const parsed = ProposalSchema.safeParse(JSON.parse(payload.text))
        if (parsed.success) receipt = { proposalId: parsed.data.proposalId, proposal: parsed.data }
      } catch {
        // Long node selections can truncate display text. The leading ID still links to authoritative client data.
        const prefix = payload.text.match(/^\s*\{\s*"proposalId"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/)
        if (prefix) {
          try {
            const parsed = Id.safeParse(JSON.parse(prefix[1]!))
            if (parsed.success) receipt = { proposalId: parsed.data }
          } catch { /* A malformed JSON escape is not a proposal identity. */ }
        }
      }
      if (receipt) last.set(receipt.proposalId, { itemId: pair.result.itemId, receipt })
    }
  }
  return new Map([...last.values()].map(({ itemId, receipt }) => [itemId, receipt]))
}

export function OrganizeProposalCard({ receipt, host }: { receipt: OrganizeReceipt; host?: OrganizeProposalHost | undefined }) {
  const m = useMessages(organizeProposalMessages)
  const format = useFormat()
  const live = host?.state(receipt.proposalId)
  const value = live ?? receipt.proposal
  return <article className="vis-organize-proposal-card" aria-label={m.title}>
    {value ? <><strong>{m.summary(m.mode(value.mode), format.number(value.changed))}</strong><p>{value.reason}</p></> : null}
    <span role="status">{live ? m.status(live.status) : m.unavailable}</span>
    {live?.status === 'pending' ? <button onClick={() => host?.open(receipt.proposalId)}>{m.preview}</button> : null}
  </article>
}
