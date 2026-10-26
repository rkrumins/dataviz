/**
 * Giving a service account a role: the workspace is found by name, a page at
 * a time, and only the roles an account may hold there are offered.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listPage, requestableRoles } = vi.hoisted(() => ({ listPage: vi.fn(), requestableRoles: vi.fn() }))

vi.mock('@/services/workspaceService', () => ({ workspaceService: { listPage } }))
vi.mock('@/services/accessRequestsService', () => ({ accessRequestsService: { requestableRoles } }))

import { RoleGrant } from '../RoleGrant'

beforeEach(() => {
    vi.clearAllMocks()
    requestableRoles.mockResolvedValue({ roles: [{ name: 'workspace_viewer', description: null, isSystem: true }] })
})

describe('RoleGrant', () => {
    it('finds the workspace to give a role in by name, a page at a time', async () => {
        listPage.mockImplementation(({ search }: { search?: string }) => Promise.resolve(search
            ? { items: [{ id: 'ws_sales', name: 'Sales' }], totalCount: 1 }
            : { items: Array.from({ length: 20 }, (_, n) => ({ id: `ws_${n}`, name: `Workspace ${n}` })), totalCount: 312 }))
        const onGrant = vi.fn().mockResolvedValue(true)
        render(<RoleGrant busy={false} onGrant={onGrant} />)
        expect(await screen.findByText('Showing 20 of 312 workspaces — find others by name.')).toBeInTheDocument()
        expect(listPage).toHaveBeenCalledWith({ limit: 20, search: '' })

        await userEvent.type(screen.getByLabelText('Find a workspace'), 'sales')
        await screen.findByRole('option', { name: 'Sales' })
        expect(listPage).toHaveBeenLastCalledWith({ limit: 20, search: 'sales' })
        await userEvent.selectOptions(screen.getByLabelText('Workspace'), 'ws_sales')
        await screen.findByRole('option', { name: 'Workspace viewer' })
        await userEvent.selectOptions(screen.getByLabelText('Role'), 'workspace_viewer')
        await userEvent.click(screen.getByRole('button', { name: /give role/i }))
        await waitFor(() => expect(onGrant).toHaveBeenCalledWith('ws_sales', 'workspace_viewer'))
    })
})
