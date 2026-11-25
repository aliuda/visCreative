import type { OrganizeColumns, OrganizeMode, OrganizeProposal } from '@vis/protocol'

export type OrganizeReview = { proposal: OrganizeProposal; detached: boolean }

/** Once the author changes a control, returning to its original value is still their own choice. */
export function editOrganizeReview(review: OrganizeReview | null, mode: OrganizeMode, columns: OrganizeColumns): OrganizeReview | null {
  if (!review || review.detached || review.proposal.mode === mode && review.proposal.columns === columns) return review
  return { ...review, detached: true }
}
