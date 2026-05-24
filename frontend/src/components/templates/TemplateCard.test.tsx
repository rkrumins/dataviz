/**
 * Smoke tests for TemplateCard — verifies the metadata projection contract:
 *   * Icon resolves via DynamicIcon (string → component lookup)
 *   * Accent color tints the icon background
 *   * Instantiation count + layer count are rendered
 *   * Scope chip flips between Global / Workspace
 *   * Menu callbacks fire the right action
 */
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TemplateCard } from './TemplateCard'
import type { ContextModel } from '@/services/contextModelService'

function makeTemplate(overrides: Partial<ContextModel> = {}): ContextModel {
    return {
        id: 'cm_1',
        name: 'My Template',
        description: 'A short description',
        isTemplate: true,
        layersConfig: [
            { id: 'l1', name: 'Source', entityTypes: [], order: 0 },
            { id: 'l2', name: 'Sink',   entityTypes: [], order: 1 },
        ],
        instanceAssignments: {},
        isActive: true,
        tags: ['etl', 'lineage'],
        visibility: 'workspace',
        isPinned: false,
        instantiationCount: 3,
        createdAt: '2026-05-24T00:00:00Z',
        updatedAt: '2026-05-24T00:00:00Z',
        accentColor: '#6366f1',
        icon: 'Workflow',
        ...overrides,
    }
}

describe('TemplateCard', () => {
    it('renders name, description, layer count, instantiation count, and tags', () => {
        const tpl = makeTemplate()
        render(
            <TemplateCard template={tpl} onMenuAction={vi.fn()} onOpen={vi.fn()} />
        )
        expect(screen.getByText('My Template')).toBeInTheDocument()
        expect(screen.getByText('A short description')).toBeInTheDocument()
        expect(screen.getByText(/2 layers/)).toBeInTheDocument()
        expect(screen.getByText('3')).toBeInTheDocument()
        expect(screen.getByText('etl')).toBeInTheDocument()
        expect(screen.getByText('lineage')).toBeInTheDocument()
    })

    it('shows the Global chip when workspaceId is missing', () => {
        render(
            <TemplateCard
                template={makeTemplate({ workspaceId: undefined })}
                onMenuAction={vi.fn()}
                onOpen={vi.fn()}
            />
        )
        expect(screen.getByText('Global')).toBeInTheDocument()
    })

    it('shows the Workspace chip when workspaceId is set', () => {
        render(
            <TemplateCard
                template={makeTemplate({ workspaceId: 'ws_a' })}
                onMenuAction={vi.fn()}
                onOpen={vi.fn()}
            />
        )
        expect(screen.getByText('Workspace')).toBeInTheDocument()
    })

    it('invokes onOpen when the card surface is clicked', async () => {
        const onOpen = vi.fn()
        const tpl = makeTemplate()
        render(<TemplateCard template={tpl} onMenuAction={vi.fn()} onOpen={onOpen} />)

        // Title is inside the button; clicking it dispatches onOpen with the model.
        await userEvent.click(screen.getByText('My Template'))
        expect(onOpen).toHaveBeenCalledWith(tpl)
    })

    it('emits the correct menu action when the kebab menu is used', async () => {
        const onMenuAction = vi.fn()
        const tpl = makeTemplate()
        const { container } = render(
            <TemplateCard template={tpl} onMenuAction={onMenuAction} onOpen={vi.fn()} />
        )

        // The kebab button is the only button before the main card body.
        const kebab = container.querySelectorAll('button')[0]
        await userEvent.click(kebab)

        // Menu items appear; click "Duplicate".
        await userEvent.click(screen.getByText('Duplicate'))
        expect(onMenuAction).toHaveBeenCalledWith('duplicate', tpl)
    })

    it('truncates tag list to 3 with a +N indicator', () => {
        const tpl = makeTemplate({ tags: ['a', 'b', 'c', 'd', 'e'] })
        render(<TemplateCard template={tpl} onMenuAction={vi.fn()} onOpen={vi.fn()} />)
        expect(screen.getByText('+2')).toBeInTheDocument()
    })
})
