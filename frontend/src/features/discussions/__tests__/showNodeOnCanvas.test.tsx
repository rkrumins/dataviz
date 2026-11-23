/**
 * "Show on canvas" from a question closes the drawer, selects the node and asks the mounted
 * canvas to reveal it — the Graph canvas pans to it, the Context view scrolls a row it has not
 * drawn yet into view, the Hierarchy opens its path — through the canvas's registered reveal.
 */
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCanvasStore } from '@/store/canvas'
import { registerCanvasReveal, revealNodeOnCanvas, useCanvasReveal } from '@/store/canvasReveal'
import { showNodeOnCanvas, useDiscussionsDrawer } from '../drawerStore'

const URN = 'urn:li:dataset:gl'

function Canvas({ reveal }: { reveal: (id: string) => void }) {
    useCanvasReveal(reveal)
    return null
}

beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0 })
    useCanvasStore.setState({ nodes: [], selectedNodeIds: [] })
    useDiscussionsDrawer.getState().open({ subject: { type: 'view', id: 'v1' }, threadId: 'd1' })
})
afterEach(() => vi.restoreAllMocks())

describe('showNodeOnCanvas', () => {
    it('closes the drawer, selects the node and has the mounted canvas reveal it', () => {
        const reveal = vi.fn()
        const canvas = render(<Canvas reveal={reveal} />)
        showNodeOnCanvas(URN)
        expect(useDiscussionsDrawer.getState().target).toBeNull()
        expect(useCanvasStore.getState().selectedNodeIds).toEqual([URN])
        expect(reveal).toHaveBeenCalledWith(URN)
        canvas.unmount()
    })

    it('reveals the canvas node that carries the urn, by its id', () => {
        useCanvasStore.setState({
            nodes: [{ id: 'n7', position: { x: 0, y: 0 }, data: { urn: URN } } as never],
        })
        const reveal = vi.fn()
        const canvas = render(<Canvas reveal={reveal} />)
        showNodeOnCanvas(URN)
        expect(reveal).toHaveBeenCalledWith('n7')
        expect(useCanvasStore.getState().selectedNodeIds).toEqual(['n7'])
        canvas.unmount()
    })

    it('still selects the node when no canvas is mounted', () => {
        expect(() => showNodeOnCanvas(URN)).not.toThrow()
        expect(useCanvasStore.getState().selectedNodeIds).toEqual([URN])
        expect(revealNodeOnCanvas(URN)).toBe(false)
    })
})

describe('the canvas reveal registry', () => {
    it('reveals through the canvas mounted now, with its latest reveal, and none once it unmounts', () => {
        const first = vi.fn()
        const later = vi.fn()
        const canvas = render(<Canvas reveal={first} />)
        canvas.rerender(<Canvas reveal={later} />)
        expect(revealNodeOnCanvas('a')).toBe(true)
        expect(first).not.toHaveBeenCalled()
        expect(later).toHaveBeenCalledWith('a')
        canvas.unmount()
        expect(revealNodeOnCanvas('b')).toBe(false)
    })

    it('a canvas leaving does not unregister the one that replaced it', () => {
        const graph = vi.fn()
        const context = vi.fn()
        const leaveGraph = registerCanvasReveal(graph)
        const leaveContext = registerCanvasReveal(context)
        leaveGraph()
        revealNodeOnCanvas('x')
        expect(context).toHaveBeenCalledWith('x')
        expect(graph).not.toHaveBeenCalled()
        leaveContext()
    })

    it('a reveal that fails is reported, not thrown', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const leave = registerCanvasReveal(() => Promise.reject(new Error('no ancestors')))
        expect(revealNodeOnCanvas('x')).toBe(true)
        await Promise.resolve()
        await Promise.resolve()
        expect(warn).toHaveBeenCalled()
        leave()
    })
})
