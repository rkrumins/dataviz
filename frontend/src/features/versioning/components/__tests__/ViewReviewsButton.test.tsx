/**
 * ViewReviewsButton — the page header's "Reviews". Its tooltip names the panel
 * it opens, Changes & Reviews, so the button and the panel read as one thing.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../hooks/useVersioning', () => ({
  useResolveGraph: () => ({ data: { graphId: 'g1', kind: 'versioned', mainHeadCommitSeq: 4 } }),
}))

import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { ViewReviewsButton } from '../ViewReviewsButton'

describe('ViewReviewsButton', () => {
  it('says in its tooltip that it opens Changes & Reviews, and opens it', async () => {
    useVersioningPanelStore.getState().clearRequest()
    render(<ViewReviewsButton workspaceId="ws_1" dataSourceId="ds_1" viewId="view_1" />)
    const user = userEvent.setup()
    const button = screen.getByRole('button', { name: 'Reviews' })
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Open Changes & Reviews/)
    await user.click(button)
    // On Published it opens on the history.
    expect(useVersioningPanelStore.getState().requestedTab).toBe('history')
  })
})
