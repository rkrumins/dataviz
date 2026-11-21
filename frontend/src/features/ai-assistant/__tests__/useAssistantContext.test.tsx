/**
 * What a question carries: a page that said what it is (and names the chip); on a view shared
 * from another workspace, that view's workspace and data source — never the person's active
 * ones; and, on the Graph and Hierarchy canvases (no canvas bridge), the canvas store's
 * selection and the entity in its drawer.
 */
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it } from 'vitest'

import { useCanvasStore, type LineageNode } from '@/store/canvas'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
import type { WorkspaceSchema } from '@/types/schema'

import { useAssistantContext } from '../lib/useAssistantContext'
import { useAssistantPage, type AssistantPageRegistration } from '../lib/useAssistantPage'
import { useAssistantStore } from '../store/assistantStore'

const initialAssistant = useAssistantStore.getState()

function schemaWith(views: Array<{ id: string; name: string; workspaceId?: string; dataSourceId?: string }>, activeViewId: string | null = null) {
    useSchemaStore.setState({
        activeViewId,
        schema: { id: 's', name: 's', version: '1', entityTypes: [], relationshipTypes: [], views, defaultViewId: null } as unknown as WorkspaceSchema,
    } as never)
}

function contextAt(path: string, page: AssistantPageRegistration | null = null) {
    const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    return renderHook(() => {
        useAssistantPage(page)
        return useAssistantContext()
    }, { wrapper }).result
}

beforeEach(() => {
    useAssistantStore.setState({ ...initialAssistant }, true)
    useWorkspacesStore.setState({ activeWorkspaceId: 'wsA', activeDataSourceId: 'dsA' } as never)
    useCanvasStore.setState({ nodes: [], selectedNodeIds: [], drawerNodeId: null } as never)
    schemaWith([])
})

describe('useAssistantContext', () => {
    it('carries the page a page registered, and names the chip after it', () => {
        const result = contextAt('/workspaces/wsB', { kind: 'workspace', id: 'wsB', title: 'Operations' })
        expect(result.current.context.page).toEqual({ kind: 'workspace', id: 'wsB', title: 'Operations' })
        expect(result.current.label).toBe('Operations')
        // Its own workspace — and no data source of the active one, which is another workspace's.
        expect(result.current.context.workspaceId).toBe('wsB')
        expect(result.current.context).not.toHaveProperty('dataSourceId')
    })

    it('on a view shared from another workspace, sends the view’s scope and never the active one', () => {
        schemaWith([{ id: 'v1', name: 'Supply chain', workspaceId: 'wsB', dataSourceId: 'dsB' }, { id: 'v2', name: 'Bare', workspaceId: 'wsB' }])
        const shared = contextAt('/views/v1')
        expect(shared.current.context).toMatchObject({
            viewId: 'v1', workspaceId: 'wsB', dataSourceId: 'dsB', page: { kind: 'view', id: 'v1', title: 'Supply chain' },
        })
        const bare = contextAt('/views/v2')
        expect(bare.current.context.workspaceId).toBe('wsB')
        expect(bare.current.context).not.toHaveProperty('dataSourceId')
        // Not loaded yet: the server resolves it from the view — the active workspace is not a guess.
        const unknown = contextAt('/views/v9')
        expect(unknown.current.context).not.toHaveProperty('workspaceId')
        expect(unknown.current.context).not.toHaveProperty('dataSourceId')
    })

    it('with no canvas bridge (Graph, Hierarchy), takes the selection from the canvas store', () => {
        schemaWith([{ id: 'v1', name: 'Graph view', workspaceId: 'wsA', dataSourceId: 'dsA' }], 'v1')
        const node = (id: string, urn: string, label: string) => ({ id, position: { x: 0, y: 0 }, data: { urn, label, type: 'dataset' } }) as LineageNode
        useCanvasStore.setState({
            nodes: [node('n1', 'urn:orders', 'orders'), node('n2', 'urn:customers', 'customers')],
            selectedNodeIds: ['n1', 'n2'], drawerNodeId: 'n2',
        } as never)
        const result = contextAt('/views/v1')
        expect(result.current.context.selectedUrns).toEqual(['urn:orders', 'urn:customers'])
        expect(result.current.context.focusUrn).toBe('urn:customers')
        expect(result.current.focus).toEqual({ urn: 'urn:customers', name: 'customers' })
        // Not the canvas this route shows: its selection is someone else's.
        schemaWith([{ id: 'v1', name: 'Graph view' }], 'v2')
        expect(contextAt('/views/v1').current.context).not.toHaveProperty('selectedUrns')
    })
})
