/**
 * The way out of an empty list: each filter with what removing it alone would
 * bring back. A row that wouldn't help still shows, so the reader learns which
 * filter is NOT the culprit; a row still counting says so instead of guessing.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { RelaxationList } from '../components/RelaxationList'
import { EMPTY_FILTERS } from '../model'

const WITHOUT_DATE = { ...EMPTY_FILTERS, tags: ['pii'] }

describe('RelaxationList', () => {
  it('offers each removal with its count, and applies the one picked', async () => {
    const user = userEvent.setup()
    const onRelax = vi.fn()
    render(
      <RelaxationList
        onRelax={onRelax}
        relaxations={[
          { key: 'updated', summary: 'Updated: Past 7 days', count: 23, next: WITHOUT_DATE },
          { key: 'sourceKind', summary: 'Versioned graphs', count: 0, next: EMPTY_FILTERS },
          { key: 'tag', summary: 'Tags: pii', count: undefined, next: EMPTY_FILTERS },
        ]}
      />,
    )
    expect(screen.getByRole('button', { name: /Updated: Past 7 days\s*\+23 views/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Versioned graphs\s*not enough on its own/ })).toBeTruthy()
    expect(screen.getByLabelText('Counting')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Updated: Past 7 days/ }))
    expect(onRelax).toHaveBeenCalledWith(WITHOUT_DATE)
  })
})
