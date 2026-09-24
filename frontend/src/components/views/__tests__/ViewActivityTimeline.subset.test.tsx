/**
 * The activity timeline says a view was made as a subset — and never names
 * the view it came from (the header does, and only to someone who can open it).
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useViewActivity', () => ({
  useViewActivity: () => ({
    isLoading: false,
    error: null,
    data: [{
      id: 'a1', viewId: 'v_new', action: 'created', actor: 'u1', actorName: 'Ada', actorEmail: null,
      summary: null, changes: { derivedFrom: 'view_secret_source', members: 12 }, createdAt: new Date().toISOString(),
    }],
  }),
}))

import { ViewActivityTimeline } from '../ViewActivityTimeline'

describe('ViewActivityTimeline — a subset\'s birth', () => {
  it('says it was made as a subset, how much it kept, and not where from', () => {
    render(<MemoryRouter><ViewActivityTimeline viewId="v_new" /></MemoryRouter>)
    expect(screen.getByText('Made as a subset of another view · 12 kept')).toBeTruthy()
    expect(document.body.textContent).not.toContain('view_secret_source')
  })
})
