/**
 * Edit and run: it starts from the search's own Cypher, runs once with the
 * chosen limits (never retried), shows typed rows and why an answer was
 * cut, points at the place a refusal means, cancels, and lights the
 * answer's entities up on the canvas — and puts them out again.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { RemoteGraphProvider } from '@/providers/RemoteGraphProvider'
import { useSearchStore } from '@/store/searchStore'
import type { NativeQueryResponse } from '@/types/search'

import { NativeConsole, STARTER_QUERY } from '../native/NativeConsole'

vi.mock('@/providers/GraphProviderContext', () => ({
    useGraphProviderIfAvailable: () => provider,
}))

const runNativeQuery = vi.fn()
let provider: RemoteGraphProvider

// jsdom measures no layout; CodeMirror asks Ranges for their boxes.
beforeAll(() => {
    const rect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }
    Range.prototype.getClientRects = (() => ({ length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] })) as never
    Range.prototype.getBoundingClientRect = (() => rect) as never
})

beforeEach(() => {
    runNativeQuery.mockReset()
    provider = Object.assign(Object.create(RemoteGraphProvider.prototype), { runNativeQuery }) as RemoteGraphProvider
    useSearchStore.getState().clear()
})

const SEED = "MATCH (n:Dataset) WHERE n.name = 'orders' RETURN n"

const node = (urn: string, name: string) => ({
    kind: 'node', id: urn, labels: ['Dataset'], urn, displayName: name, properties: { owner: 'data team' },
})

function answer(over: Partial<NativeQueryResponse> = {}): NativeQueryResponse {
    return {
        engine: 'falkordb', columns: ['n'], rows: [[node('urn:a', 'orders')], [node('urn:b', 'orders_raw')]],
        rowCount: 2, truncated: false, truncatedReason: null, limitApplied: 200, timeoutMs: 10000,
        executedQuery: `${SEED} LIMIT 201`, queryHash: 'abc123', elapsedMs: 12, notes: [],
        requestId: 'req_1', ...over,
    }
}

const editorText = () => (document.querySelector('.cm-content') as HTMLElement).textContent
const open = () => fireEvent.click(screen.getByRole('button', { name: /Edit and run/ }))
const runIt = async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Run' })) })
}


describe('NativeConsole', () => {
    it('starts from the search, or from a starter query without one', () => {
        const { unmount } = render(<NativeConsole viewId="v" engine="falkordb" seed={SEED} />)
        open()
        expect(editorText()).toBe(SEED)
        unmount()
        render(<NativeConsole viewId="v" engine="neo4j" seed={null} />)
        open()
        expect(editorText()).toBe(STARTER_QUERY)
        expect(screen.getByText(/read-only · Neo4j/)).toBeTruthy()
    })

    it('is not offered where it cannot run, and says why', () => {
        render(<NativeConsole viewId="v" engine="falkordb" seed={SEED} unavailable="Switch the view to main." />)
        const button = screen.getByRole('button', { name: /Edit and run/ }) as HTMLButtonElement
        expect(button.disabled).toBe(true)
        expect(button.title).toBe('Switch the view to main.')
    })

    it('runs with the chosen limits and shows typed rows', async () => {
        runNativeQuery.mockResolvedValue(answer({
            truncated: true, truncatedReason: 'rows', notes: ['Added LIMIT 1001: at most 1,000 rows are shown.'],
        }))
        render(<NativeConsole viewId="v" engine="falkordb" seed={SEED} />)
        open()
        fireEvent.change(screen.getByLabelText('Rows'), { target: { value: '1000' } })
        await runIt()

        expect(runNativeQuery).toHaveBeenCalledTimes(1)
        const [body, opts] = runNativeQuery.mock.calls[0]
        expect(body).toEqual({ query: SEED, limit: 1000, timeoutMs: 10000 })
        expect(opts.signal).toBeInstanceOf(AbortSignal)
        expect(screen.getByRole('table', { name: 'Query results' })).toBeTruthy()
        expect(screen.getByText('orders_raw')).toBeTruthy()
        expect(screen.getByText(/More rows matched/)).toBeTruthy()
        expect(screen.getByText('Added LIMIT 1001: at most 1,000 rows are shown.')).toBeTruthy()
    })

    it('points at the place a refusal means, and quotes the request id when the server failed', async () => {
        const refusal = JSON.stringify({ detail: {
            code: 'native_query_refused', message: 'LOAD reads files or URLs, and native queries only read.',
            requestId: 'req_9', position: 0,
        } })
        runNativeQuery.mockRejectedValueOnce(Object.assign(new Error(`API Error 400: ${refusal}`), { status: 400 }))
        render(<NativeConsole viewId="v" engine="falkordb" seed={SEED} />)
        open()
        await runIt()
        expect(screen.getByRole('alert').textContent).toContain('LOAD reads files or URLs')
        expect(screen.queryByText(/Request req_9/)).toBeNull()        // a refusal needs no request id
        expect(document.querySelector('.cm-lintRange-error')).toBeTruthy()

        const failed = JSON.stringify({ detail: { code: 'native_query_failed', message: 'The query failed.', requestId: 'req_10' } })
        runNativeQuery.mockRejectedValueOnce(Object.assign(new Error(`API Error 500: ${failed}`), { status: 500 }))
        await runIt()
        expect(screen.getByText('Request req_10')).toBeTruthy()
    })

    it('cancels a run in flight', async () => {
        let signal: AbortSignal | undefined
        runNativeQuery.mockImplementation((_body, opts) => {
            signal = opts.signal
            return new Promise(() => {})
        })
        render(<NativeConsole viewId="v" engine="falkordb" seed={SEED} />)
        open()
        await runIt()
        fireEvent.click(screen.getByRole('button', { name: /Cancel/ }))
        expect(signal?.aborted).toBe(true)
        expect(screen.getByText('Cancelled.')).toBeTruthy()
    })

    it('stops a run in flight when it goes away', async () => {
        let signal: AbortSignal | undefined
        runNativeQuery.mockImplementation((_body, opts) => {
            signal = opts.signal
            return new Promise(() => {})
        })
        const { unmount } = render(<NativeConsole viewId="v" engine="falkordb" seed={SEED} />)
        open()
        await runIt()
        unmount()
        expect(signal?.aborted).toBe(true)
    })

    it('lights the answer up on the canvas, and puts it out', async () => {
        runNativeQuery.mockResolvedValue(answer())
        render(<NativeConsole viewId="view-1" engine="falkordb" seed={SEED} />)
        open()
        await runIt()
        fireEvent.click(screen.getByRole('button', { name: /Highlight on canvas \(2\)/ }))
        const state = useSearchStore.getState()
        expect([...state.matchUrnSet]).toEqual(['urn:a', 'urn:b'])
        expect(state.queryHash).toBe('native:abc123')
        expect(state.viewId).toBe('view-1')

        fireEvent.click(screen.getByRole('button', { name: /Clear highlight/ }))
        expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
        expect(useSearchStore.getState().queryHash).toBeNull()
    })
})
