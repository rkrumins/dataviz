/**
 * DisplayRuleList — each card reads its rule's count in the whole view
 * (from ``displayRuleMatchStore``): "Counting…" before the first answer,
 * what has been found so far while the count runs, the exact total once
 * it is done, and why a rule can't be counted. Reveal runs the rule as a
 * search, so it only waits on a finished count that found nothing.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RuleCount } from '@/services/ruleCounts'
import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import type { DisplayRuleConfig } from '@/types/schema'

import { DisplayRuleList } from '../DisplayRuleList'


vi.mock('@/components/ui/DynamicIcon', () => ({
    DynamicIcon: ({ name }: { name: string }) => <span data-icon={name} />,
}))


function rule(over: Partial<DisplayRuleConfig> = {}): DisplayRuleConfig {
    return {
        id: 'pii', name: 'PII', color: '#6366f1', enabled: true,
        predicate: { kind: 'tag', op: 'hasAny', values: ['PII'] },
        createdAt: '2026-01-01T00:00:00Z', ...over,
    }
}

function renderList(r: DisplayRuleConfig, count?: RuleCount) {
    if (count) useDisplayRuleMatchStore.getState().setCounts(new Map([[r.id, count]]))
    const onReveal = vi.fn()
    render(
        <DisplayRuleList
            rules={[r]}
            onNew={vi.fn()} onEdit={vi.fn()} onToggle={vi.fn()} onDelete={vi.fn()}
            onReorder={vi.fn()} onReveal={onReveal}
        />,
    )
    return { onReveal, reveal: screen.getByTitle('Show every match in search') }
}


describe('DisplayRuleList count line', () => {
    beforeEach(() => useDisplayRuleMatchStore.getState().clear())

    it('reads "Counting…" before the first answer, with Reveal already available', async () => {
        const { reveal, onReveal } = renderList(rule())
        expect(screen.getByText('Counting…')).toBeInTheDocument()
        expect(reveal).toBeEnabled()
        await userEvent.setup().click(reveal)
        expect(onReveal).toHaveBeenCalledWith(expect.objectContaining({ id: 'pii' }))
    })

    it('shows what has been found so far while the count runs', () => {
        renderList(rule(), { count: 12_431, complete: false, percent: 64 })
        expect(screen.getByText('12,431')).toBeInTheDocument()
        expect(screen.getByText(/so far · counting 64%/)).toBeInTheDocument()
    })

    it('shows the exact total once counted', () => {
        renderList(rule(), { count: 48_203, complete: true, percent: 100 })
        expect(screen.getByText('48,203')).toBeInTheDocument()
        expect(screen.getByText(/matches in this view/)).toBeInTheDocument()
    })

    it('says "match" for exactly one', () => {
        renderList(rule(), { count: 1, complete: true, percent: 100 })
        expect(screen.getByText(/match in this view/)).toBeInTheDocument()
    })

    it('disables Reveal only once the count has finished and found nothing', () => {
        const { reveal } = renderList(rule(), { count: 0, complete: true, percent: 100 })
        expect(reveal).toBeDisabled()
    })

    it('keeps Reveal available while a count has found nothing yet', () => {
        const { reveal } = renderList(rule(), { count: 0, complete: false, percent: 10 })
        expect(reveal).toBeEnabled()
    })

    it("says why a rule can't be counted", () => {
        renderList(rule(), { count: 0, complete: true, percent: 100, error: 'Unknown operator' })
        expect(screen.getByText("Can't be counted")).toHaveAttribute('title', 'Unknown operator')
    })

    it('reads a stopped count as a floor, and says it stopped', () => {
        renderList(rule(), {
            count: 12_431, complete: false, percent: 64, error: 'The count stopped: Service Unavailable',
        })
        expect(screen.getByText('12,431')).toBeInTheDocument()
        expect(screen.getByText(/At least/)).toHaveAttribute('title', 'The count stopped: Service Unavailable')
        expect(screen.getByText('count stopped')).toBeInTheDocument()
        expect(screen.queryByText(/counting/)).not.toBeInTheDocument()
    })

    it('reads "Disabled" for a disabled rule, and cannot reveal it', () => {
        const { reveal } = renderList(rule({ enabled: false }))
        expect(screen.getByText('Disabled')).toBeInTheDocument()
        expect(reveal).toBeDisabled()
    })
})
