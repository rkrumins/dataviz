/**
 * "Is this workspace alive, and what do people come here for?"
 *
 * A name, a member count and a source list say what a workspace CONTAINS.
 * None of them say whether anybody has been here this month, and none say
 * what it is for — which is the half a stranger needs.
 */
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'

import { WorkspaceUsageLine } from '../WorkspaceUsageLine'
import type { WorkspaceUsage } from '@/services/contentInsightsService'

function usage(over: Partial<WorkspaceUsage> = {}): WorkspaceUsage {
    return {
        workspaceId: 'ws1', views: 8, opens: 340, uniqueViewers: 12,
        topView: { viewId: 'v1', name: 'Revenue lineage', opens: 120 },
        windowDays: 30, ...over,
    }
}

function renderLine(u: WorkspaceUsage | undefined) {
    return render(<MemoryRouter><WorkspaceUsageLine usage={u} /></MemoryRouter>)
}

describe('WorkspaceUsageLine', () => {
    it('says who is here and what they come for', () => {
        renderLine(usage())
        expect(screen.getByText(/12/)).toBeInTheDocument()
        expect(screen.getByText(/340 opens/)).toBeInTheDocument()
        // One click from the question to the answer.
        expect(screen.getByRole('link', { name: 'Revenue lineage' }))
            .toHaveAttribute('href', '/views/v1')
    })

    it('calls a workspace with content but no traffic quiet', () => {
        renderLine(usage({ opens: 0, uniqueViewers: 0, topView: null }))
        expect(screen.getByText(/quiet/i)).toBeInTheDocument()
    })

    it('says nothing about a workspace whose views it cannot read', () => {
        // Zeros here would be a claim about content the reader is not allowed
        // to know exists.
        const { container } = renderLine(usage({ views: 0, opens: 0, topView: null }))
        expect(container).toBeEmptyDOMElement()
    })

    it('renders nothing at all while the rollup is unknown', () => {
        const { container } = renderLine(undefined)
        expect(container).toBeEmptyDOMElement()
    })
})
