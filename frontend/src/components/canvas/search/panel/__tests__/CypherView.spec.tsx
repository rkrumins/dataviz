/**
 * The Cypher tab: the query in words, then what it compiles to — or, in
 * each state that has no Cypher to show, why not, said once. Below it,
 * Edit and run — only for whoever the server says may query the view's
 * source, and only where that source takes native queries.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useBranchStore } from '@/store/branchStore'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { usePersonaStore } from '@/store/persona'
import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchExplainResult } from '@/types/search'

import { CypherView } from '../CypherView'
import type { CompiledQuery } from '../native/useCompiledQuery'

vi.mock('../native/useCompiledQuery', () => ({ useCompiledQuery: () => compiled }))
vi.mock('@/providers/ViewExecutionContext', async (importOriginal) => ({
    ...await importOriginal<object>(),
    useViewExecutionContext: () => context,
}))

let compiled: CompiledQuery
let context: { access: { canQueryDataSource: boolean; nativeQueryEngine: string | null } } | null

// jsdom measures no layout; CodeMirror asks Ranges for their boxes.
beforeAll(() => {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    Range.prototype.getClientRects = (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as never
    Range.prototype.getBoundingClientRect = (() => rect) as never
})

const DATASETS: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }

const INLINED = "MATCH (n) WHERE n.entityType IN ['dataset'] RETURN n"
const COMPILED = {
    status: 'ok',
    result: {
        cypher: 'MATCH (n) WHERE n.entityType IN $p0 RETURN n',
        inlinedCypher: INLINED,
        params: { p0: ['dataset'] },
        notes: [],
    } as unknown as SearchExplainResult,
} as const

/** The switch, and what the view's access says about its source. */
function allow(on: boolean, canQueryDataSource: boolean, nativeQueryEngine: string | null) {
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, nativeQueryEnabled: on } })
    context = { access: { canQueryDataSource, nativeQueryEngine } }
}

beforeEach(() => {
    useSearchStore.getState().clear()
    useSearchStore.getState().seedDraftPredicate(DATASETS)
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES } })
    useBranchStore.setState({ currentBranchId: null, mainBranchId: null })
    context = null
})


describe('CypherView', () => {
    it('reads the query in words above what it compiles to', () => {
        compiled = { status: 'compiling' }
        render(<CypherView viewId="view-1" />)
        expect(screen.getByText(/dataset/)).toBeTruthy()
        expect(screen.getByText('Compiling the query…')).toBeTruthy()
    })

    it.each([
        [{ status: 'empty' } as const, 'Add a condition to see the Cypher it runs as.'],
        [{ status: 'unsupported' } as const, /doesn't show a compiled query/],
        [{ status: 'error', message: 'That property does not exist' } as const, 'That property does not exist'],
    ])('says why there is no Cypher: %o', (state, says) => {
        compiled = state
        render(<CypherView viewId="view-1" />)
        expect(screen.getByText(says)).toBeTruthy()
        expect(screen.queryByRole('textbox', { name: 'Compiled Cypher' })).toBeNull()
    })

    it('shows the compiled Cypher, read-only, and copies it with its values written in', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.assign(navigator, { clipboard: { writeText } })
        compiled = COMPILED
        render(<CypherView viewId="view-1" />)

        const editor = screen.getByRole('textbox', { name: 'Compiled Cypher' })
        expect(editor.textContent).toContain('n.entityType IN $p0')
        expect(editor.getAttribute('aria-readonly')).toBe('true')
        // Coloured as a parameter, and listed with its value among the
        // engine's details — folded for Business, a click away.
        expect(screen.getAllByText('$p0').map((el) => el.className)).toContain('text-rose-700 dark:text-rose-300')
        expect(screen.queryByText('["dataset"]')).toBeNull()
        fireEvent.click(screen.getByRole('button', { name: /Engine details/ }))
        expect(screen.getByText('["dataset"]')).toBeTruthy()

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy with values/ })) })
        expect(writeText).toHaveBeenCalledWith(INLINED)
    })

    it('opens the engine\'s details for Technical', () => {
        usePersonaStore.getState().setMode('technical')
        compiled = COMPILED
        render(<CypherView viewId="view-1" />)
        expect(screen.getByRole('button', { name: /Engine details/ })).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText('["dataset"]')).toBeTruthy()
        usePersonaStore.getState().setMode('business')
    })

    it.each([
        [true, true, 'falkordb', true],
        [true, true, 'neo4j', true],
        [false, true, 'falkordb', false],       // the switch is off
        [true, false, 'falkordb', false],       // not theirs to query
        [true, true, null, false],              // the source takes no native queries
    ])('offers Edit and run when on=%s, may query=%s, engine=%s: %s', (on, may, engine, offered) => {
        compiled = COMPILED
        allow(on, may, engine)
        render(<CypherView viewId="view-1" />)
        expect(Boolean(screen.queryByRole('button', { name: /Edit and run/ }))).toBe(offered)
    })

    it('starts Edit and run from the compiled Cypher with its values written in', () => {
        compiled = COMPILED
        allow(true, true, 'falkordb')
        render(<CypherView viewId="view-1" />)
        fireEvent.click(screen.getByRole('button', { name: /Edit and run/ }))
        expect(screen.getByRole('textbox', { name: 'Your Cypher' }).textContent).toBe(INLINED)
    })

    it('on a draft, says why it cannot run', () => {
        compiled = COMPILED
        allow(true, true, 'falkordb')
        useBranchStore.setState({ currentBranchId: 'br_draft', mainBranchId: 'br_main' })
        render(<CypherView viewId="view-1" />)
        const button = screen.getByRole('button', { name: /Edit and run/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.title).toMatch(/Switch the view to main/)
    })
})
