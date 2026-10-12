/**
 * Reveal on a display rule runs the rule's criteria as a search — the
 * search panel then lists every match in the view with its exact count —
 * instead of spotlighting only the matches the canvas had loaded.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDisplayRuleMatchStore } from '@/store/displayRuleMatchStore'
import { useReferenceModelStore } from '@/store/referenceModelStore'
import type { DisplayRuleConfig } from '@/types/schema'
import type { Predicate } from '@/types/search'

import { PropertyManagerDrawer } from '../PropertyManagerDrawer'


const notify = vi.fn()

vi.mock('@/components/ui/notifications', () => ({
    useAppNotifications: () => ({ notify }),
}))

vi.mock('@/components/ui/DynamicIcon', () => ({
    DynamicIcon: ({ name }: { name: string }) => <span data-icon={name} />,
}))


const predicate: Predicate = {
    kind: 'group', op: 'and',
    children: [{
        kind: 'property', key: 'gvHash', op: 'eq', value: '-3746471915534728000', valueType: 'number',
    }],
}

const rule: DisplayRuleConfig = {
    id: 'hash', name: 'One hash', color: '#6366f1', predicate, enabled: true,
    createdAt: '2026-01-01T00:00:00Z',
}


describe('PropertyManagerDrawer reveal', () => {
    beforeEach(() => {
        notify.mockReset()
        useDisplayRuleMatchStore.getState().clear()
        useReferenceModelStore.setState({ displayRules: [rule] })
    })

    it("runs the rule's criteria as a search", async () => {
        const onSearchPredicate = vi.fn()
        render(
            <PropertyManagerDrawer
                viewId="view-1" open onClose={vi.fn()} onSearchPredicate={onSearchPredicate}
            />,
        )
        await userEvent.setup().click(screen.getByTitle('Show every match in search'))
        expect(onSearchPredicate).toHaveBeenCalledWith(predicate)
        expect(notify).toHaveBeenCalledWith('info', 'Showing the matches for “One hash”')
    })
})
