import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/permissionsService', () => {
    const emptyPreview = {
        affectedUsers: 0, affectedWorkspaces: 0,
        gainedPerms: [], lostPerms: [], userImpact: [],
    }
    return {
        permissionsService: {
            updateRole: vi.fn().mockResolvedValue({}),
            resetRole: vi.fn().mockResolvedValue({}),
            deleteRole: vi.fn().mockResolvedValue(undefined),
            previewRoleUpdate: vi.fn().mockResolvedValue(emptyPreview),
            previewRoleReset: vi.fn().mockResolvedValue(emptyPreview),
            previewRoleDelete: vi.fn().mockResolvedValue(emptyPreview),
        },
    }
})

import { RoleEditorDrawer } from '../AdminPermissions'
import { permissionsService } from '@/services/permissionsService'

const PERMS = [
    { id: 'system:admin', description: 'Platform owner', category: 'system' as const, longDescription: null, examples: [], impliedBy: [] },
    { id: 'system:bindings:read', description: 'List bindings', category: 'system' as const, longDescription: null, examples: [], impliedBy: [] },
    { id: 'workspace:view:read', description: 'Read views', category: 'workspace' as const, longDescription: null, examples: [], impliedBy: [] },
    { id: 'workspace:view:edit', description: 'Edit views', category: 'workspace' as const, longDescription: null, examples: [], impliedBy: [] },
]

function superAdmin(over: Record<string, unknown> = {}) {
    return {
        name: 'super_admin', description: 'Platform owner',
        scopeType: 'global' as const, scopeId: null, isSystem: true,
        permissions: ['system:admin', 'system:bindings:read'],
        createdAt: null, updatedAt: null, createdBy: null, bindingCount: 0,
        isModified: false,
        lockedPermissions: ['system:admin', 'system:bindings:read'],
        ...over,
    }
}

function rowFor(permId: string): HTMLElement {
    const code = screen.getByText(permId)
    const row = code.closest('[role="button"]')
    if (!row) throw new Error(`no row for ${permId}`)
    return row as HTMLElement
}

beforeEach(() => vi.clearAllMocks())

describe('RoleEditorDrawer — system roles', () => {
    it('is editable and locks floor permissions', async () => {
        render(
            <RoleEditorDrawer
                role={superAdmin()} permissions={PERMS}
                onClose={() => {}} onChanged={async () => {}}
            />,
        )

        // System roles now show the Save footer (no longer read-only).
        expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument()

        // The floor permission renders locked (Required) and is not toggleable.
        expect(screen.getAllByText('Required').length).toBeGreaterThan(0)
        expect(rowFor('system:admin').getAttribute('aria-disabled')).toBe('true')

        // A non-locked permission toggles and gates the save on an impact preview.
        fireEvent.click(rowFor('workspace:view:edit'))
        fireEvent.click(screen.getByRole('button', { name: /save changes/i }))
        await waitFor(() =>
            expect(permissionsService.previewRoleUpdate).toHaveBeenCalledWith(
                'super_admin', expect.arrayContaining(['workspace:view:edit']),
            ),
        )
    })

    it('disables reset when unmodified and previews when modified', async () => {
        const { rerender } = render(
            <RoleEditorDrawer
                role={superAdmin({ isModified: false })} permissions={PERMS}
                onClose={() => {}} onChanged={async () => {}}
            />,
        )
        expect(screen.getByRole('button', { name: /reset to default/i })).toBeDisabled()

        rerender(
            <RoleEditorDrawer
                role={superAdmin({ isModified: true })} permissions={PERMS}
                onClose={() => {}} onChanged={async () => {}}
            />,
        )
        const resetBtn = screen.getByRole('button', { name: /reset to default/i })
        expect(resetBtn).not.toBeDisabled()
        fireEvent.click(resetBtn)
        await waitFor(() =>
            expect(permissionsService.previewRoleReset).toHaveBeenCalledWith('super_admin'),
        )
    })
})
