/**
 * The Cypher tab: the query in words, then what it compiles to — or, in
 * each state that has no Cypher to show, why not, said once.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { useSearchStore } from '@/store/searchStore'
import type { Predicate, SearchExplainResult } from '@/types/search'

import { CypherView } from '../CypherView'
import type { CompiledQuery } from '../native/useCompiledQuery'

vi.mock('../native/useCompiledQuery', () => ({ useCompiledQuery: () => compiled }))

let compiled: CompiledQuery

// jsdom measures no layout; CodeMirror asks Ranges for their boxes.
beforeAll(() => {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    Range.prototype.getClientRects = (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as never
    Range.prototype.getBoundingClientRect = (() => rect) as never
})

const DATASETS: Predicate = { kind: 'entityType', op: 'in', values: ['dataset'] }

beforeEach(() => {
    useSearchStore.getState().clear()
    useSearchStore.getState().seedDraftPredicate(DATASETS)
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
        compiled = {
            status: 'ok',
            result: {
                cypher: 'MATCH (n) WHERE n.entityType IN $p0 RETURN n',
                inlinedCypher: "MATCH (n) WHERE n.entityType IN ['dataset'] RETURN n",
                params: { p0: ['dataset'] },
                notes: [],
            } as unknown as SearchExplainResult,
        }
        render(<CypherView viewId="view-1" />)

        const editor = screen.getByRole('textbox', { name: 'Compiled Cypher' })
        expect(editor.textContent).toContain('n.entityType IN $p0')
        expect(editor.getAttribute('aria-readonly')).toBe('true')
        // Coloured as a parameter, and listed with its value.
        expect(screen.getAllByText('$p0').map((el) => el.className)).toContain('text-rose-700 dark:text-rose-300')
        expect(screen.getByText('["dataset"]')).toBeTruthy()

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Copy with values/ })) })
        expect(writeText).toHaveBeenCalledWith("MATCH (n) WHERE n.entityType IN ['dataset'] RETURN n")
    })
})
