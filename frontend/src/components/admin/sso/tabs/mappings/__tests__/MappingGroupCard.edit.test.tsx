/**
 * Editing opens where the rule lives.
 *
 * The pencil sits on the row, and the row itself morphs into the editor
 * the tab supplies — no modal, no navigation, the rule stays in the
 * card it belongs to. While a row is the editor, its own delete button
 * is gone: two destructive affordances on one open editor is a misclick
 * factory.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { MappingGroupCard } from '../MappingGroupCard'
import type { IdpGroupMapping, IdpProvider } from '@/services/ssoAdminService'

const ROW = {
    id: 'map_1', providerId: null, idpGroup: 'group1',
    targetType: 'group_membership', roleName: null, scopeType: null,
    scopeId: null, targetGroupId: 'grp_1',
} as IdpGroupMapping

const GROUPS = [{ id: 'grp_1', name: 'Use Case A' }] as never[]

function renderCard(over: Partial<Parameters<typeof MappingGroupCard>[0]> = {}) {
    const onEdit = vi.fn()
    render(
        <MappingGroupCard
            group={{ idpGroup: 'group1', rows: [ROW] }}
            providers={[] as IdpProvider[]}
            workspaces={[]}
            groups={GROUPS}
            busy={false}
            index={0}
            onDelete={() => {}}
            onEdit={onEdit}
            {...over}
        />,
    )
    return { onEdit }
}

describe('the edit affordance', () => {
    it('the pencil names the rule and hands its id up', async () => {
        const user = userEvent.setup()
        const { onEdit } = renderCard()

        await user.click(
            screen.getByRole('button', { name: /edit this rule for group1/i }),
        )
        expect(onEdit).toHaveBeenCalledWith('map_1')
    })

    it('the editing row becomes the editor, in place', () => {
        renderCard({
            editingId: 'map_1',
            editor: () => <div data-testid="inline-editor" />,
        })

        expect(screen.getByTestId('inline-editor')).toBeInTheDocument()
        // The row's own affordances are gone while it is the editor.
        expect(
            screen.queryByRole('button', { name: /edit this rule/i }),
        ).toBeNull()
        expect(
            screen.queryByRole('button', { name: /remove this rule/i }),
        ).toBeNull()
        // The rule's rendered target is the editor's job now.
        expect(screen.queryByText('Use Case A')).toBeNull()
    })
})
