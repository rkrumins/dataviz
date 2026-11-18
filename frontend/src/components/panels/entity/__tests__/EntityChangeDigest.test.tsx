/**
 * The drawer's digest: what the draft saved on the entity, in one line — and how much is staged but
 * not saved yet; nothing for an entity the draft has not touched.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EntityChangeDigest } from '../EntityChangeDigest'

const published = { displayName: 'orders', properties: { owner: 'ana', tier: 'silver' } }

describe('EntityChangeDigest', () => {
  it('says what the draft saved on it, and what is staged on top', () => {
    render(<EntityChangeDigest unsavedFields={2} baseline={{
      status: 'modified', published, saved: { displayName: 'orders', properties: { owner: 'bea', tier: 'silver', steward: 'cy' } },
    }} />)
    expect(screen.getByRole('status')).toHaveTextContent(/In this draft/)
    expect(screen.getByText('Edited owner · added steward')).toBeInTheDocument()
    expect(screen.getByText('2 not saved yet')).toBeInTheDocument()
  })

  it('says nothing for an entity the draft has not touched', () => {
    const { container } = render(<EntityChangeDigest unsavedFields={0} baseline={{ status: 'unchanged', published, saved: published }} />)
    expect(container).toBeEmptyDOMElement()
  })
})
