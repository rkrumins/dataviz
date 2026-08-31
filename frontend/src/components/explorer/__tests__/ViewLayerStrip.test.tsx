/**
 * ViewLayerStrip — the card shows THIS view's layers, not its category.
 *
 * The defect these pin: the Explorer card's preview slot rendered `MiniPreview`,
 * a stock SVG keyed only on `viewType`, so all sixty-five Context Views in the
 * grid drew the identical block. A third of every card restated the label
 * directly above it, on the one screen whose job is telling views apart.
 *
 * What jsdom CANNOT check here, said plainly: there is no layout and no
 * compositor, so nothing below asserts that four columns fit, that a long name
 * truncates, or that the strip reads well at 3.75rem. Those are live checks.
 * What is pinned is everything that decides WHICH layers reach the DOM and what
 * they are painted with — the parts a refactor can silently break.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ViewLayerStrip } from '../ViewLayerStrip'
import type { ViewLayerConfig } from '@/types/schema'

const layer = (over: Partial<ViewLayerConfig> & { id: string }): ViewLayerConfig => ({
    name: over.id,
    entityTypes: [],
    order: 0,
    ...over,
})

const LAYERS: ViewLayerConfig[] = [
    layer({ id: 'src', name: 'Source', color: '#6366f1', order: 0, entityTypes: ['a', 'b'] }),
    layer({ id: 'stg', name: 'Staging', color: '#f59e0b', order: 1, entityTypes: ['c'] }),
    layer({ id: 'trn', name: 'Transform', color: '#10b981', order: 2, entityTypes: [] }),
    layer({ id: 'srv', name: 'Serve', color: '#ec4899', order: 3, entityTypes: ['d'] }),
    layer({ id: 'rpt', name: 'Report', color: '#0ea5e9', order: 4, entityTypes: ['e'] }),
    layer({ id: 'arc', name: 'Archive', color: '#64748b', order: 5, entityTypes: [] }),
    layer({ id: 'lab', name: 'Lab', color: '#a855f7', order: 6, entityTypes: ['f'] }),
]

describe('ViewLayerStrip', () => {
    it('names the view’s own layers — the whole point of replacing the stock picture', () => {
        render(<ViewLayerStrip layers={LAYERS.slice(0, 3)} />)
        expect(screen.getByText('Source')).toBeInTheDocument()
        expect(screen.getByText('Staging')).toBeInTheDocument()
        expect(screen.getByText('Transform')).toBeInTheDocument()
    })

    it('orders by the authored order, not the array order', () => {
        // The canvas draws these left to right by `order`; a card that showed
        // the first four as they happened to arrive would disagree with the
        // board it is previewing.
        const shuffled = [LAYERS[3], LAYERS[0], LAYERS[2], LAYERS[1]]
        const { container } = render(<ViewLayerStrip layers={shuffled} />)
        const names = [...container.querySelectorAll('span.font-semibold')].map(n => n.textContent)
        expect(names).toEqual(['Source', 'Staging', 'Transform', 'Serve'])
    })

    it('falls back to `sequence` when `order` is absent', () => {
        const bySequence = [
            layer({ id: 'b', name: 'Bravo', sequence: 1, order: undefined as unknown as number }),
            layer({ id: 'a', name: 'Alpha', sequence: 0, order: undefined as unknown as number }),
        ]
        const { container } = render(<ViewLayerStrip layers={bySequence} />)
        const names = [...container.querySelectorAll('span.font-semibold')].map(n => n.textContent)
        expect(names).toEqual(['Alpha', 'Bravo'])
    })

    it('caps the columns and COUNTS the rest, rather than drawing slivers', () => {
        render(<ViewLayerStrip layers={LAYERS} />)          // 7 layers
        expect(screen.getByText('Source')).toBeInTheDocument()
        expect(screen.getByText('Serve')).toBeInTheDocument()
        // The fifth onwards is a count, not a column: four columns in ~250px
        // leave ~56px each, and nine would be nine illegible slivers.
        expect(screen.queryByText('Report')).toBeNull()
        expect(screen.getByText('+3')).toBeInTheDocument()
    })

    it('shows no overflow chip when every layer got a column', () => {
        render(<ViewLayerStrip layers={LAYERS.slice(0, 4)} />)
        expect(screen.queryByText(/^\+\d+$/)).toBeNull()
    })

    it('paints each layer in ITS OWN colour, inline', () => {
        // Inline, and it has to be: `layer.color` is authored per view and
        // arrives as a hex at runtime, while Tailwind's JIT only ever sees
        // source text. It also steps around the repo's dead-alpha trap — an
        // eight-digit hex is resolved by the browser, where a `/8` modifier on
        // a bare var() token compiles to nothing at all.
        // jsdom normalises an inline hex to rgb()/rgba(), so assert the
        // RESOLVED colour — which also proves the browser accepts the
        // eight-digit form rather than dropping it as an unparseable value.
        const { container } = render(<ViewLayerStrip layers={[LAYERS[0]]} />)
        const accent = container.querySelector('div.h-\\[2px\\]') as HTMLElement
        expect(accent.style.backgroundColor).toBe('rgb(99, 102, 241)')

        const name = screen.getByText('Source') as HTMLElement
        expect(name.style.color).toBe('rgb(99, 102, 241)')

        // The column's own tint is the same hue, carried at low alpha.
        const column = accent.parentElement as HTMLElement
        expect(column.style.backgroundColor).toMatch(/^rgba\(99, 102, 241,/)
        expect(column.style.borderColor).toMatch(/^rgba\(99, 102, 241,/)
    })

    it('draws a tick per entity type, capped, and none for an empty layer', () => {
        const { container } = render(<ViewLayerStrip layers={[LAYERS[2]]} />)  // Transform: []
        expect(container.querySelectorAll('span.rounded-\\[1px\\]')).toHaveLength(0)

        const many = render(
            <ViewLayerStrip layers={[layer({ id: 'x', name: 'Wide', color: '#111111', entityTypes: ['1', '2', '3', '4', '5', '6'] })]} />,
        )
        expect(many.container.querySelectorAll('span.rounded-\\[1px\\]')).toHaveLength(3)
    })

    it('renders nothing at all for a view with no layers, so the card can fall back', () => {
        const { container } = render(<ViewLayerStrip layers={[]} />)
        expect(container.firstChild).toBeNull()
    })

    it('announces itself once, as one image — not four loose words', () => {
        render(<ViewLayerStrip layers={LAYERS} />)
        expect(screen.getByRole('img')).toHaveAttribute(
            'aria-label',
            '7 layers: Source, Staging, Transform, Serve and 3 more',
        )
    })

    it('uses the singular for one layer', () => {
        render(<ViewLayerStrip layers={[LAYERS[0]]} />)
        expect(screen.getByRole('img')).toHaveAttribute('aria-label', '1 layer: Source')
    })

    it('constructs no ResizeObserver and starts no timer — the drawer\'s version does both', () => {
        // THE PERF CONTRACT, and the reason this is not just the drawer's
        // `ReferenceLayerPreview` reused. That component carries per-instance
        // state, an effect, a scroll listener and a ResizeObserver — correct
        // for one panel, sixty-five times the wrong thing in a grid. If someone
        // "unifies" the two by importing that one here, this fails.
        const ro = vi.fn(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }))
        const realRO = globalThis.ResizeObserver
        const timer = vi.spyOn(globalThis, 'setInterval')
        const raf = vi.spyOn(globalThis, 'requestAnimationFrame')
        globalThis.ResizeObserver = ro as unknown as typeof ResizeObserver
        try {
            render(<ViewLayerStrip layers={LAYERS} />)
            expect(ro).not.toHaveBeenCalled()
            expect(timer).not.toHaveBeenCalled()
            expect(raf).not.toHaveBeenCalled()
        } finally {
            globalThis.ResizeObserver = realRO
            timer.mockRestore()
            raf.mockRestore()
        }
    })

    it('is memoised, so a list refresh does not re-render sixty-five of them', () => {
        // Structural, deliberately: the render output is identical either way,
        // so asserting on the DOM could not tell a working memo from a missing
        // one. What a refactor actually breaks is the wrapper itself.
        expect((ViewLayerStrip as unknown as { $$typeof: symbol }).$$typeof)
            .toBe(Symbol.for('react.memo'))
        // And it carries a CUSTOM comparator — the default shallow compare is
        // useless here, because the parent rebuilds the layers array on every
        // list refresh and identity always differs.
        expect(typeof (ViewLayerStrip as unknown as { compare: unknown }).compare)
            .toBe('function')
    })
})
