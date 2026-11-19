/**
 * ApprovalPill — how far a review's approvals are: as its rule counts them where the server says
 * (everyone asked, or N of anyone's), else the reviewers who approved; nothing when it needs none.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PullRequest } from '@/services/versioningApiService'
import { ApprovalPill } from '../components/PrMeta'

const pr = (over: Partial<PullRequest>): PullRequest => ({ prId: 'pr_1', status: 'mergeable', ...over } as PullRequest)
const review = (requiredApprovals: number, approvals: { required: number; have: number; satisfied: boolean }) =>
  ({ requiredApprovals, approvals, reviewers: [], changeRequests: [], threads: { open: 0, holdMerge: false } })

describe('ApprovalPill', () => {
  it('counts N of anyone’s approvals under a rule that asks for N', () => {
    render(<ApprovalPill pr={pr({ reviewers: ['a', 'b', 'c'], approvedBy: ['a'],
      review: review(2, { required: 2, have: 1, satisfied: false }) })} />)
    expect(screen.getByText('1/2')).toBeInTheDocument()
  })

  it('counts everyone asked under the built-in rule, and reads done once satisfied', () => {
    render(<ApprovalPill pr={pr({ reviewers: ['a', 'b'], approvedBy: ['a', 'b'],
      review: review(0, { required: 2, have: 2, satisfied: true }) })} />)
    expect(screen.getByText('2/2')).toBeInTheDocument()
    expect(screen.getByText('2/2').className).toMatch(/emerald/)
  })

  it('falls back to the reviewers approved, and hides when nothing is needed', () => {
    render(<ApprovalPill pr={pr({ reviewers: ['a', 'b'], approvedBy: ['b'] })} />)
    expect(screen.getByText('1/2')).toBeInTheDocument()
    const { container } = render(<ApprovalPill pr={pr({ review: review(0, { required: 0, have: 0, satisfied: true }) })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
