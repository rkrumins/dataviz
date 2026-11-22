/**
 * ReviewStep — where a change reaches, said once and truly: the whole view across the whole data
 * source is "every entity in the data source", never "every entity in this view, across the whole
 * data source"; other targets keep their words and add the data source.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { OpDraft, ScopeMode, TargetPreset } from '../opModel'
import { ReviewStep } from '../ReviewStep'

const op: OpDraft = { kind: 'set', key: 'owner', to: '', value: 'data-team', onConflict: 'skip' }

function review(preset: TargetPreset, scopeMode: ScopeMode) {
  render(
    <ReviewStep op={op} preset={preset} scopeMode={scopeMode} counts={null}
      impact={{ changes: 10, replaced: 0, untouched: 0 }} exact preview={null} previewLoading={false}
      sample={null} sampleLoading={false} stagedCount={0} />,
  )
}

describe('ReviewStep — where it reaches', () => {
  it('the whole view across the whole data source is the data source', () => {
    review({ kind: 'view' }, 'data_source')
    expect(screen.getByText(/on every entity in the data source\./)).toBeInTheDocument()
    expect(screen.queryByText(/in this view, across/)).toBeNull()
  })

  it('a property’s holders across the whole data source say so', () => {
    review({ kind: 'hasKey', key: 'owner' }, 'data_source')
    expect(screen.getByText(/on every entity with owner, across the whole data source\./)).toBeInTheDocument()
  })

  it('a target the server searches is matched on the draft, ones new in it included', () => {
    review({ kind: 'hasKey', key: 'owner' }, 'view')
    expect(screen.getByText(/Entities are matched on your draft as the change starts, ones new in it included/)).toBeInTheDocument()
    expect(screen.queryByText(/found as published/)).toBeNull()
  })
})
