/**
 * ReviewStep — a change that takes the draft past what its counts follow: past DRAFT_LARGE changed
 * entities, the draft's counts and property list show the published graph and it is slower to
 * open, so Review says so before the change is applied, with the way through (publish in parts).
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { DRAFT_LARGE, type OpDraft } from '../opModel'
import { ReviewStep } from '../ReviewStep'

const op: OpDraft = { kind: 'set', key: 'owner', to: '', value: 'data-team', onConflict: 'skip' }

function review(draftChanges: number | undefined, changes: number) {
  render(
    <ReviewStep op={op} preset={{ kind: 'view' }} scopeMode="view" counts={null}
      impact={{ changes, replaced: 0, untouched: 0 }} exact preview={null} previewLoading={false}
      sample={null} sampleLoading={false} stagedCount={0} draftChanges={draftChanges} />,
  )
}

describe('ReviewStep — a draft this change makes very large', () => {
  it('says so, and offers publishing in parts, when the draft would pass DRAFT_LARGE', () => {
    review(DRAFT_LARGE - 1_000, 50_000)
    expect(screen.getByText(/will hold about 249,000 changed entities/)).toBeInTheDocument()
    expect(screen.getByText(/publish it in parts/)).toBeInTheDocument()
  })

  it('says nothing for a draft that stays under it, or one whose size isn’t known', () => {
    review(10_000, 50_000)
    expect(screen.queryByText(/changed entities\. Past/)).toBeNull()
    review(undefined, 500_000)
    expect(screen.queryByText(/changed entities\. Past/)).toBeNull()
  })
})
