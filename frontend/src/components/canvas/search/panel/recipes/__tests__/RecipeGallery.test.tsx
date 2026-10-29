/**
 * Recipes as people meet them: a few to start from on the empty card, each
 * counted here, opening out to all of them by intent — one ready to run
 * runs, one with something to fill in opens the Sentence view there.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ViewSearchSessionContext } from '@/components/canvas/search/session/ViewSearchSessionContext'
import { ProviderOverride } from '@/providers/GraphProviderContext'
import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { SearchCountsRequest } from '@/types/search'
import { stubAdvanced, stubSession } from '@/test/stubSearchSession'

import { SearchMapPanel } from '../../../SearchMapPanel'
import { EDITOR_MODE_KEY } from '../../builderMode'
import { RecipeGallery } from '../RecipeGallery'
import { recipesFor } from '../recipes'


const typeName = (t: string, plural?: boolean) => (plural ? `${t}s` : t)
const RECIPES = recipesFor({
    types: ['dataset', 'dashboard'], tags: ['PII'], keys: ['owner', 'description'], layers: [],
}, typeName)

function withCounts(count: number) {
    const provider = Object.create(RemoteGraphProvider.prototype) as RemoteGraphProvider
    Object.assign(provider, {
        searchCounts: vi.fn(async (body: SearchCountsRequest) => ({
            counts: Object.fromEntries(body.items.map((i) => [i.id, { count, status: 'complete' }])),
        })),
    })
    return function Wrapper({ children }: { children: ReactNode }) {
        return (
            <ProviderOverride value={{ provider, isLoading: false, error: null, scopeKind: 'ready',
                workspaceId: 'ws', dataSourceId: null, providerReady: true, providerVersion: 1 } as never}>
                <MemoryRouter>{children}</MemoryRouter>
            </ProviderOverride>
        )
    }
}


describe('RecipeGallery', () => {
    it('starts with one recipe per intent, each counted, and opens out to all of them', async () => {
        const onPick = vi.fn()
        render(<RecipeGallery viewId="view-1" recipes={RECIPES} variant="starters" onPick={onPick} />,
            { wrapper: withCounts(7) })
        const starters = screen.getByRole('list', { name: 'Recipes to start from' })
        expect(within(starters).getAllByRole('button').map((b) => b.querySelector('.text-sm')?.textContent)).toEqual([
            'datasets that feed 3 or more others', 'datasets that feed dashboards', 'Everything tagged PII',
            'datasets without a description', 'datasets without an owner', 'datasets with no lineage at all',
            'All datasets',
        ].map((t) => t.charAt(0).toUpperCase() + t.slice(1)))
        expect(await within(starters).findAllByText('7')).toHaveLength(7)

        fireEvent.click(screen.getByRole('button', { name: `All ${RECIPES.length}` }))
        expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual([
            'Impact', 'Root cause', 'Governance & PII', 'Documentation gaps', 'Ownership', 'Cleanup', 'Discovery',
        ])
        // Something to fill in isn't counted: it says so.
        const byName = screen.getByRole('button', { name: /Find something by name/ })
        expect(within(byName).getByText('fill in')).toBeInTheDocument()
        fireEvent.click(byName)
        expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'by-name', blank: true }))
    })

    it('says when a recipe finds nothing in this view, and narrows to the words asked for', async () => {
        render(<RecipeGallery viewId="view-1" recipes={RECIPES} variant="all" filter="owner" onPick={vi.fn()} />,
            { wrapper: withCounts(0) })
        expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Ownership'])
        expect(await screen.findAllByText('none in this view')).toHaveLength(2)
    })

    it('asks no count for a Connections recipe — the count request would refuse it, and every count with it', async () => {
        const recipes = recipesFor({ types: ['dataset'], tags: [], keys: [],
            layers: [{ value: 'raw', label: 'Raw' }, { value: 'gold', label: 'Gold' }] }, typeName)
        const wrapper = withCounts(4)
        render(<RecipeGallery viewId="view-1" recipes={recipes} variant="all" onPick={vi.fn()} />, { wrapper })
        const flows = screen.getByRole('button', { name: /What flows from Raw to Gold/ })
        expect((await screen.findAllByText('4')).length).toBeGreaterThan(0)
        expect(within(flows).queryByText('4')).not.toBeInTheDocument()
    })
})


describe('SearchMapPanel — starting from a recipe', () => {
    beforeEach(() => {
        localStorage.clear()
        useSearchStore.getState().clear()
    })

    function renderPanel() {
        const advanced = stubAdvanced()
        const session = stubSession({ refineOpen: true, advanced })
        render(
            <ViewSearchSessionContext.Provider value={session}>
                <SearchMapPanel open onClose={vi.fn()} viewId="view-1" session={advanced} onClear={session.clearQuery} />
            </ViewSearchSessionContext.Provider>,
            { wrapper: withCounts(3) },
        )
        return advanced
    }

    it('runs a recipe ready to run at once', () => {
        const advanced = renderPanel()
        fireEvent.click(screen.getByRole('button', { name: /Where lineage starts/ }))
        const starts = { kind: 'group', op: 'and', children: [
            { kind: 'isRoot', edgeClass: 'lineage' }, { kind: 'hasOutgoing', edgeClass: 'lineage' }] }
        expect(useSearchStore.getState().draftPredicate).toEqual(starts)
        expect(advanced.runPredicate).toHaveBeenCalledTimes(1)
        expect(advanced.runPredicate).toHaveBeenCalledWith(starts, expect.anything())
    })

    it('leaves a recipe with something to fill in as an empty field in the Form cards', () => {
        const advanced = renderPanel()
        fireEvent.click(screen.getByRole('button', { name: /^All \d+/ }))
        fireEvent.click(screen.getByRole('button', { name: /Find something by name/ }))
        expect(advanced.runPredicate).not.toHaveBeenCalled()
        expect(screen.getByRole('radio', { name: 'Form' })).toHaveAttribute('aria-checked', 'true')
        expect(useSearchStore.getState().draftPredicate).toMatchObject({ kind: 'text', value: '', target: 'name' })
        expect(useSearchStore.getState().pendingOpenBlank).toBe(false)
    })

    it('opens it at its blank for someone building in the Sentence view', async () => {
        localStorage.setItem(EDITOR_MODE_KEY, 'sentence')
        const advanced = renderPanel()
        fireEvent.click(screen.getByRole('button', { name: /^All \d+/ }))
        fireEvent.click(screen.getByRole('button', { name: /Find something by name/ }))
        expect(advanced.runPredicate).not.toHaveBeenCalled()
        expect(screen.getByRole('radio', { name: 'Sentence' })).toHaveAttribute('aria-checked', 'true')
        const editor = await screen.findByRole('dialog')
        expect(editor).toContainElement(document.activeElement as HTMLElement)
        expect(useSearchStore.getState().pendingOpenBlank).toBe(false)
    })
})
