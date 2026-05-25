import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FeaturedTemplateCard } from './FeaturedTemplateCard'
import { pickFeaturedTemplate } from './pickFeaturedTemplate'
import type { ContextModel } from '@/services/contextModelService'

function makeTemplate(overrides: Partial<ContextModel> = {}): ContextModel {
    return {
        id: 'cm_1',
        name: 'My Template',
        description: 'A short description',
        isTemplate: true,
        layersConfig: [{ id: 'l1', name: 'Source', entityTypes: [], order: 0 }],
        instanceAssignments: {},
        isActive: true,
        tags: [],
        visibility: 'workspace',
        isPinned: false,
        instantiationCount: 0,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        accentColor: '#a855f7',
        icon: 'LayoutTemplate',
        ...overrides,
    }
}

describe('pickFeaturedTemplate', () => {
    it('returns null when fewer than two templates', () => {
        expect(pickFeaturedTemplate([])).toBeNull()
        expect(pickFeaturedTemplate([makeTemplate()])).toBeNull()
    })

    it('prefers a pinned template even when another has more instantiations', () => {
        const pinned = makeTemplate({ id: 'pinned', isPinned: true, instantiationCount: 1 })
        const popular = makeTemplate({ id: 'popular', isPinned: false, instantiationCount: 99 })
        expect(pickFeaturedTemplate([popular, pinned])?.id).toBe('pinned')
    })

    it('falls back to highest instantiation count when no pin', () => {
        const a = makeTemplate({ id: 'a', instantiationCount: 5 })
        const b = makeTemplate({ id: 'b', instantiationCount: 12 })
        const c = makeTemplate({ id: 'c', instantiationCount: 3 })
        expect(pickFeaturedTemplate([a, b, c])?.id).toBe('b')
    })

    it('falls back to most-recently updated when instantiation counts tie', () => {
        const older = makeTemplate({ id: 'older', updatedAt: '2026-01-01T00:00:00Z' })
        const newer = makeTemplate({ id: 'newer', updatedAt: '2026-05-25T00:00:00Z' })
        expect(pickFeaturedTemplate([older, newer])?.id).toBe('newer')
    })
})

describe('FeaturedTemplateCard', () => {
    it('renders Featured tag, name, description, and instantiation count', () => {
        const tpl = makeTemplate({ name: 'Hero Pipeline', description: 'The big one', instantiationCount: 7 })
        render(<FeaturedTemplateCard template={tpl} onOpen={vi.fn()} />)
        expect(screen.getByText('Featured')).toBeInTheDocument()
        expect(screen.getByText('Hero Pipeline')).toBeInTheDocument()
        expect(screen.getByText('The big one')).toBeInTheDocument()
        expect(screen.getByText(/instantiations/)).toBeInTheDocument()
    })

    it('invokes onOpen with the template when clicked', async () => {
        const onOpen = vi.fn()
        const tpl = makeTemplate()
        render(<FeaturedTemplateCard template={tpl} onOpen={onOpen} />)
        await userEvent.click(screen.getByText('My Template'))
        expect(onOpen).toHaveBeenCalledWith(tpl)
    })

    it('shows the Pinned badge when isPinned', () => {
        render(
            <FeaturedTemplateCard template={makeTemplate({ isPinned: true })} onOpen={vi.fn()} />,
        )
        expect(screen.getByText('Pinned')).toBeInTheDocument()
    })
})
