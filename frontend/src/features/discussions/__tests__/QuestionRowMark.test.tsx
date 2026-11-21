/**
 * A row or card with questions about it carries an amber "?" and how many are open — a quiet one
 * once all are answered — and nothing at all otherwise. Clicking it opens the questions drawer on
 * just those questions, without selecting the row under it. "Ask about this" opens the ask box
 * about the node, on the view the canvas shows, and only while questions are on.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { useCanvasStore } from '@/store/canvas'
import { usePersonaStore } from '@/store/persona'
import { useViewExecutionContext } from '@/providers/ViewExecutionContext'
import { QuestionRowMark } from '../QuestionRowMark'
import { useAnchorStore } from '../anchorStore'
import { useDiscussionsDrawer } from '../drawerStore'
import { useAskAboutNode } from '../useAskAboutNode'

vi.mock('@/providers/ViewExecutionContext', async (orig) => ({
    ...(await orig<typeof import('@/providers/ViewExecutionContext')>()),
    useViewExecutionContext: vi.fn(),
}))

beforeEach(() => {
    useAnchorStore.setState({ viewId: null, byEntity: {} })
    useDiscussionsDrawer.setState({ target: null })
    useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
    vi.mocked(useViewExecutionContext).mockReturnValue({ viewId: 'v1' } as ReturnType<typeof useViewExecutionContext>)
})

describe('QuestionRowMark', () => {
    it('draws nothing for a row nobody asked about, or on a view with no questions', () => {
        const { container } = render(<QuestionRowMark urn="urn:a" label="A" />)
        expect(container).toBeEmptyDOMElement()
        act(() => useAnchorStore.getState().set('v1', { 'urn:b': { open: 1, total: 1 } }))
        expect(container).toBeEmptyDOMElement()
    })

    it('counts the open questions about the row', () => {
        useAnchorStore.getState().set('v1', { 'urn:a': { open: 2, total: 3 } })
        render(<QuestionRowMark urn="urn:a" label="Orders" />)
        const mark = screen.getByRole('button', { name: '2 open questions about this' })
        expect(mark).toHaveTextContent('?2')
        expect(mark.className).toMatch(/bg-amber/)
    })

    it('stays, quieter, once every question is answered or closed', () => {
        useAnchorStore.getState().set('v1', { 'urn:a': { open: 0, total: 1 } })
        render(<QuestionRowMark urn="urn:a" label="Orders" />)
        const mark = screen.getByRole('button', { name: '1 question about this, all answered or closed' })
        expect(mark.className).not.toMatch(/bg-amber/)
    })

    it('opens the drawer on the questions about that row, without selecting the row', () => {
        useAnchorStore.getState().set('v1', { 'urn:a': { open: 1, total: 1 } })
        const onRowClick = vi.fn()
        render(<div onClick={onRowClick}><QuestionRowMark urn="urn:a" label="Orders" /></div>)
        fireEvent.click(screen.getByRole('button', { name: '1 open question about this' }))
        expect(onRowClick).not.toHaveBeenCalled()
        expect(useDiscussionsDrawer.getState().target).toMatchObject({
            subject: { type: 'view', id: 'v1' }, entity: { id: 'urn:a', label: 'Orders' }, threadId: null, compose: false,
        })
    })
})

describe('useAskAboutNode', () => {
    it('opens the ask box about the node, on the canvas’s view, named as the reader reads it', () => {
        usePersonaStore.setState({ mode: 'business' })
        useCanvasStore.setState({ nodes: [{ id: 'urn:a', position: { x: 0, y: 0 }, data: { label: 'orders_raw', businessLabel: 'Orders', urn: 'urn:a', type: 'dataset' } }] } as never)
        const { result } = renderHook(() => useAskAboutNode())
        act(() => result.current!('urn:a'))
        expect(useDiscussionsDrawer.getState().target).toMatchObject({
            subject: { type: 'view', id: 'v1' }, entity: { id: 'urn:a', label: 'Orders' }, compose: true,
        })
    })

    it('offers nothing while questions are off, or outside a saved view', () => {
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: false } })
        expect(renderHook(() => useAskAboutNode()).result.current).toBeUndefined()
        useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, conversationsEnabled: true } })
        vi.mocked(useViewExecutionContext).mockReturnValue(null)
        expect(renderHook(() => useAskAboutNode()).result.current).toBeUndefined()
    })
})
