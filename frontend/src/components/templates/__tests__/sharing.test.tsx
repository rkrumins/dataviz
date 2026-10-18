/**
 * Who can use a template: the audience tiles say why one is out of reach,
 * shares are listed and changed in place, an organization template takes no
 * shares, and "Save as template" keeps a view's structure but none of its
 * placements.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutTemplate } from '@/services/layoutTemplateService'
import type { ViewLayerConfig } from '@/types/schema'

const { service, notify } = vi.hoisted(() => ({
    service: {
        create: vi.fn(), update: vi.fn(),
        grants: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    },
    notify: vi.fn(),
}))

vi.mock('@/services/layoutTemplateService', () => ({ layoutTemplateService: service }))
vi.mock('@/components/ui/notifications', () => ({ useAppNotifications: () => ({ notify }) }))
vi.mock('@/hooks/useLayoutTemplates', () => ({ useInvalidateLayoutTemplates: () => () => undefined }))
vi.mock('@/store/workspaces', () => {
    const state = { workspaces: [{ id: 'ws_fin', name: 'Finance' }, { id: 'ws_ops', name: 'Ops' }] }
    const useWorkspacesStore = Object.assign(
        (selector: (s: typeof state) => unknown) => selector(state),
        { getState: () => state },
    )
    return { useWorkspacesStore }
})

import { useAuthStore } from '@/store/auth'
import { AudiencePicker } from '../AudiencePicker'
import { SaveAsTemplateDialog } from '../SaveAsTemplateDialog'
import { ShareTemplateDialog } from '../ShareTemplateDialog'

const MINE: LayoutTemplate = {
    id: 'tpl_mine', name: 'My flow', description: null, category: null, visibility: 'private',
    builtIn: false, hidden: false, workspaceId: null, workspaceName: null, createdBy: 'usr_me',
    createdAt: '', updatedAt: '', usageCount: 0, grantCount: 1, version: 1,
    layers: [{ id: 'l1', name: 'Sources', entityTypes: [], order: 0 }],
    access: { via: 'owner', canEdit: true, canDelete: true, canShare: true, canHide: false },
}

const GRANT = {
    grantId: 'grant_1', role: 'viewer' as const, grantedAt: '', grantedBy: 'usr_me',
    subject: { type: 'group' as const, id: 'grp_1', displayName: 'Platform team', secondary: '4 members' },
}

beforeEach(() => {
    vi.clearAllMocks()
    useAuthStore.setState({ permissions: { global: [], ws: { ws_ops: ['workspace:view:create'] } } } as never)
})

describe('AudiencePicker', () => {
    it('keeps out-of-reach audiences visible but closed, and picks a workspace you can add to', () => {
        const onChange = vi.fn()
        render(<AudiencePicker visibility="private" workspaceId={null} onChange={onChange} />)
        expect(screen.getByRole('radio', { name: /Personal/ })).toBeEnabled()
        expect(screen.getByRole('radio', { name: /Organization/ })).toBeDisabled()
        fireEvent.click(screen.getByRole('radio', { name: /Workspace/ }))
        // Only Ops lets this person create there.
        expect(onChange).toHaveBeenCalledWith({ visibility: 'workspace', workspaceId: 'ws_ops' })
    })

    it('opens the organization to a template manager', () => {
        useAuthStore.setState({ permissions: { global: ['system:templates:manage'], ws: {} } } as never)
        render(<AudiencePicker visibility="private" workspaceId={null} onChange={vi.fn()} />)
        expect(screen.getByRole('radio', { name: /Organization/ })).toBeEnabled()
        expect(screen.getByRole('radio', { name: /Workspace/ })).toBeDisabled()
    })
})

describe('ShareTemplateDialog', () => {
    it('lists who it is shared with, and changes or ends a share in place', async () => {
        service.grants.list.mockResolvedValue([GRANT])
        service.grants.update.mockResolvedValue({ ...GRANT, role: 'editor' })
        service.grants.delete.mockResolvedValue(undefined)
        render(<ShareTemplateDialog template={MINE} onClose={vi.fn()} />)

        const row = (await screen.findByText('Platform team')).closest('li') as HTMLElement
        fireEvent.click(within(row).getByRole('button', { name: /editor/i }))
        await waitFor(() => expect(service.grants.update).toHaveBeenCalledWith('tpl_mine', 'grant_1', 'editor'))

        fireEvent.click(within(row).getByRole('button', { name: 'Stop sharing with Platform team' }))
        await waitFor(() => expect(service.grants.delete).toHaveBeenCalledWith('tpl_mine', 'grant_1'))
        expect(await screen.findByText(/Not shared with anyone yet/)).toBeInTheDocument()
    })

    it('takes no shares for an organization template', () => {
        render(
            <ShareTemplateDialog
                template={{ ...MINE, visibility: 'enterprise', access: { ...MINE.access, canShare: false } }}
                onClose={vi.fn()}
            />,
        )
        expect(screen.getByText(/open to everyone signed in/)).toBeInTheDocument()
        expect(service.grants.list).not.toHaveBeenCalled()
    })
})

describe('SaveAsTemplateDialog', () => {
    it("keeps a view's structure, none of its placements, as a personal template by default", async () => {
        service.create.mockResolvedValue({ ...MINE, id: 'tpl_saved', name: 'Orders layout' })
        const onClose = vi.fn()
        const layers = [{
            id: 'l1', name: 'Domains', entityTypes: ['domain'], order: 0, anchorUrn: 'urn:li:domain:finance',
            rules: [{ id: 'exact', urnPattern: 'urn:li:dataset:1', priority: 1 }],
        }] as ViewLayerConfig[]
        render(
            <MemoryRouter>
                <SaveAsTemplateDialog sourceName="Orders" layers={layers} onClose={onClose} />
            </MemoryRouter>,
        )

        expect(screen.getByDisplayValue('Orders layout')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /save template/i }))

        await waitFor(() => expect(service.create).toHaveBeenCalledTimes(1))
        const body = service.create.mock.calls[0][0]
        expect(body).toMatchObject({ name: 'Orders layout', visibility: 'private', workspaceId: null })
        expect(body.layers[0]).not.toHaveProperty('anchorUrn')
        expect(body.layers[0].rules).toEqual([])
        expect(notify).toHaveBeenCalledWith('success', 'Saved "Orders layout" to your templates', expect.objectContaining({ label: 'Open' }))
        expect(onClose).toHaveBeenCalled()
    })
})
