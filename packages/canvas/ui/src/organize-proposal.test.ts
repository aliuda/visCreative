import type { OrganizeProposal } from '@vis/protocol'
import { messagesFor, formatter } from '@vis/ui-kit'
import { describe, expect, it } from 'vitest'
import { editOrganizeReview } from './organize-proposal'
import { organizeProposalMessages } from './messages'

const proposal: OrganizeProposal = { proposalId: 'proposal', sessionId: 'session', mode: 'category', columns: 'auto', nodeIds: ['a', 'b'], reason: 'Keep the result area together.', changed: 3, status: 'pending', createdAt: 1 }

describe('Organize proposal preview', () => {
  it('keeps unchanged parameters locked and permanently detaches a changed mode or column count', () => {
    const review = { proposal, detached: false }
    expect(editOrganizeReview(review, 'category', 'auto')).toBe(review)
    for (const [mode, columns] of [['script', 'auto'], ['category', 2]] as const) {
      const changed = editOrganizeReview(review, mode, columns)
      expect(changed).toEqual({ proposal, detached: true })
      expect(editOrganizeReview(changed, 'category', 'auto')).toBe(changed)
    }
    expect(editOrganizeReview(null, 'category', 2)).toBeNull()
    expect(proposal.nodeIds).toEqual(['a', 'b'])
  })

  it('formats the bar count and all three directions in both locales', () => {
    for (const locale of ['en', 'zh-CN'] as const) {
      const m = messagesFor(organizeProposalMessages, locale)
      const count = formatter(locale).number(1234)
      for (const mode of ['category', 'script', 'inPlace'] as const) {
        const text = m.suggestion('Layout partner', count, m.mode(mode), proposal.reason)
        expect(text).toContain(count)
        expect(text).toContain(m.mode(mode))
        expect(text).toContain(proposal.reason)
      }
    }
  })
})
