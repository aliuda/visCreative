import type { OrganizeProposal, TranscriptItem } from '@vis/protocol'
import { messagesFor } from '@vis/ui-kit'
import { describe, expect, it } from 'vitest'
import { organizeProposalResults } from './OrganizeProposalCard'
import { organizeProposalMessages } from './messages'
import { workTranscript } from './workBlocks'

const proposal: OrganizeProposal = { proposalId: 'proposal', sessionId: 'session', mode: 'script', columns: 'auto', changed: 12, reason: 'Read results in shot order.', status: 'pending', createdAt: 1 }
const item = (itemId: string, kind: TranscriptItem['kind'], payload: unknown): TranscriptItem => ({ itemId, kind, payload, turnId: 'turn', revision: 1, createdAt: 1, updatedAt: 1, createdSeq: 1 })
const call = (id: string, name = 'vis.canvas_organize_propose') => item(`${id}-call`, 'tool_call', { name, toolUseId: id })
const result = (id: string, text = JSON.stringify(proposal), isError = false) => item(`${id}-result`, 'tool_result', { text, isError, toolUseId: id })

describe('Organize proposal receipts', () => {
  it('places a single card after the last successful proposal receipt, separate from the work block', () => {
    const items = [call('a'), result('a'), call('b'), result('b'), item('reply', 'assistant_text', { text: 'Please review' })]
    expect([...organizeProposalResults(items).keys()]).toEqual(['b-result'])
    expect(workTranscript(items).map(group => group.kind)).toEqual(['work', 'organizeProposal', 'item'])
    expect(workTranscript(items)[1]).toEqual({ kind: 'organizeProposal', receipt: { proposalId: 'proposal', proposal } })
  })
  it('links a truncated large selection by its leading ID instead of reconstructing state from transcript text', () => {
    const text = JSON.stringify({ ...proposal, nodeIds: Array.from({ length: 1000 }, (_, i) => `node-${i}`) }).slice(0, 4000)
    expect([...organizeProposalResults([call('a'), result('a', text)]).values()]).toEqual([{ proposalId: 'proposal' }])
  })
  it('ignores failures, unrelated tools, malformed IDs, orphan receipts and assistant text', () => {
    const items = [call('a'), result('a', JSON.stringify(proposal), true), call('b', 'vis.canvas_get'), result('b'),
      call('c'), result('c', '{"proposalId":""'), call('d'), result('d', '{"proposalId":"\\x",'), result('orphan'), item('assistant', 'assistant_text', { text: JSON.stringify(proposal) })]
    expect(organizeProposalResults(items).size).toBe(0)
  })
  it('localizes every terminal state and each mode', () => {
    const m = messagesFor(organizeProposalMessages, 'en')
    expect(['pending', 'applied', 'dismissed', 'stale', 'superseded', 'expired'].map(status => m.status(status as OrganizeProposal['status'])))
      .toEqual(['Pending', 'Applied', 'Dismissed', 'Stale', 'Superseded', 'Expired'])
    expect(['category', 'script', 'inPlace'].map(mode => m.mode(mode as OrganizeProposal['mode']))).toEqual(['By category', 'By script', 'In place'])
  })
})
