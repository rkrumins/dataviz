/**
 * A row of Explorer cards has to line up, whatever is written on them.
 *
 * The reported shape: in a grid of sixty-five, the illustration sat at a
 * different height on almost every card. A name that wrapped to two lines, a
 * description of nought, one or two lines, and a data source that did or did
 * not exist each shifted everything below them — so the strongest visual
 * element on the card landed at four different heights across one row, and the
 * row read as broken even though the footers were perfectly aligned.
 *
 * THE RULE THIS FILE EXISTS TO PIN: reserve height ABOVE the preview, never
 * below. Above it, every variable block decides where the illustration starts,
 * so each one holds its full height whether or not it has content — that, and
 * only that, is what makes a row line up.
 *
 * Below it, a reserve buys nothing but a hole. The grid is `items-start`, so a
 * card is its natural height and a short one does not get stretched to match
 * the wordiest card in its row; reserving height under the preview just moves
 * the emptiness inside the card instead. Both halves are asserted together,
 * because fixing either one alone is what produced the problem twice: reserves
 * everywhere gave stretched cards full of holes, and reserves nowhere gave a
 * ragged row.
 *
 * WHAT JSDOM CANNOT DO HERE, plainly: there is no layout engine, so nothing
 * below measures a single pixel. `getBoundingClientRect` is all zeroes and
 * `line-clamp` does not clamp. These assert the CSS CONTRACT that produces the
 * alignment — the reserves being declared, and the preview's frame matching its
 * artwork — which is the part a refactor deletes. Whether the result actually
 * lines up on screen is a live check.
 */
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { ExplorerViewCard } from '../ExplorerViewCard'
import type { View } from '@/services/viewApiService'

const view = (over: Partial<View> = {}): View => ({
    id: 'v1',
    name: 'Impact Analysis',
    viewType: 'reference',
    workspaceId: 'ws-1',
    workspaceName: 'Writes',
    dataSourceId: 'ds-1',
    dataSourceName: 'Nexus Lineage',
    visibility: 'private',
    tags: [],
    createdAt: '2026-07-13T12:26:00Z',
    updatedAt: '2026-07-13T12:26:00Z',
    ...over,
} as View)

const noop = () => {}

function renderCard(v: View) {
    return render(
        <MemoryRouter>
            <ExplorerViewCard
                view={v}
                onToggleFavourite={noop}
                onShare={noop}
                onPreview={vi.fn()}
            />
        </MemoryRouter>,
    )
}

/** The illustration's frame — the element whose top edge must match across a row. */
const PREVIEW_H = 'h-\\[4rem\\]'
const previewFrame = (c: HTMLElement) =>
    c.querySelector(`.${PREVIEW_H}`) as HTMLElement

describe('Explorer card — the preview starts at the same height on every card', () => {
    it('reserves two lines for the name, so a wrapped title does not shift the card', () => {
        const short = renderCard(view({ name: 'ABCDE' }))
        const heading = short.container.querySelector('h3') as HTMLElement
        expect([...heading.classList]).toContain('min-h-[2.1875rem]')
        // And it still clamps, so a very long name cannot push past the reserve
        // in the other direction.
        expect([...heading.classList]).toContain('line-clamp-2')
    })

    it('reserves ONE line for the description even when the view has none', () => {
        // The block a "tidy up the empty space" pass deletes first — and the
        // single biggest source of the ragged row, because a description is
        // the most variable thing above the illustration. Moving it below the
        // preview to dodge the reserve was tried and is worse: the row's card
        // bottoms go ragged, which reads worse than the empty line. One line
        // rather than two, because most views carry no description at all.
        const { container } = renderCard(view({ description: undefined }))
        const reserved = container.querySelector('.min-h-\\[1\\.125rem\\]')
        expect(reserved, 'the description keeps its line with nothing in it').toBeTruthy()
        expect(reserved!.textContent).toBe('')
    })

    it('keeps the description ABOVE the preview, where the alignment depends on it', () => {
        const { container } = renderCard(view({ description: 'A described view' }))
        const desc = screen.getByText('A described view')
        const frame = previewFrame(container)
        expect(
            frame.compareDocumentPosition(desc) & Node.DOCUMENT_POSITION_PRECEDING,
            'the description precedes the illustration',
        ).toBeTruthy()
    })

    it('reserves both badge rows, so a view with no data source lines up too', () => {
        const { container } = renderCard(view({ dataSourceId: undefined, dataSourceName: undefined }))
        expect(container.querySelector('.min-h-\\[2\\.75rem\\]')).toBeTruthy()
        // The second row genuinely is absent — the reserve is what holds the space.
        expect(screen.queryByText('Nexus Lineage')).toBeNull()
    })

    it('keeps the illustration SMALL — it is decoration, not the subject', () => {
        // It draws the same picture on every Context View, which is the type,
        // which the label above it already says. Handing it the artwork's own
        // ratio gave it ~112px at full card width and turned a browsable grid
        // into two and a half rows. Decoration loses that argument: it takes a
        // modest fixed height and gives up the width.
        const { container } = renderCard(view())
        const frame = previewFrame(container)
        expect(frame, 'the preview keeps a small fixed height').toBeTruthy()
        expect(container.querySelector('[class*="aspect-["]'), 'never aspect-driven').toBeNull()
    })

    it('draws on a canvas shaped like the frame, so the art is not stranded in it', () => {
        // `preserveAspectRatio` defaults to `meet`, which scales to the SHORTER
        // side — so a 5:2 drawing in a ~5.4:1 slot landed about 130px wide in a
        // 280px box and read as a small cluster floating in a large empty
        // frame. The canvas has to be roughly as wide-to-tall as the slot, or
        // the art gets letterboxed however big the slot is. Every viewType
        // shares the frame, so every viewType shares the canvas.
        for (const viewType of ['reference', 'graph', 'layered-lineage', 'hierarchy']) {
            const { container } = renderCard(view({ id: viewType, viewType } as Partial<View>))
            const box = previewFrame(container).querySelector('svg')?.getAttribute('viewBox')
            expect(box, `${viewType} has an illustration`).toBeTruthy()
            const [, , w, h] = box!.split(' ').map(Number)
            expect(w / h, `${viewType} is drawn wide, not letterboxed`).toBeGreaterThan(4)
        }
    })

    it('does NOT reserve height below the preview — the spacer aligns the footers', () => {
        // The other half of the rule. Reserving down here is pure waste: the
        // grid is `items-start`, so the card ends where its content ends and
        // the footer sits directly under it. A view with no tags should leave
        // no reserved hole between its illustration and its footer.
        const { container } = renderCard(view({ tags: [] }))
        const frame = previewFrame(container)
        const below = [...container.querySelectorAll('[class*="min-h-"]')]
            .filter(el => frame.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)
        expect(below.map(el => el.className), 'nothing below the preview reserves height').toEqual([])
        expect(container.querySelector('.flex-1'), 'the spacer that does the aligning').toBeTruthy()
    })

    it('renders the same structural skeleton whatever the card is carrying', () => {
        // The end-to-end statement: two cards that differ in every variable way
        // still produce the same sequence of reserved blocks, in the same order.
        const skeleton = (c: HTMLElement) =>
            [...c.querySelectorAll(`h3, .min-h-\\[2\\.75rem\\], .min-h-\\[1\\.125rem\\], .${PREVIEW_H}`)]
                .map(el => (el.tagName === 'H3' ? 'title' : el.className.match(/min-h-\[[^\]]+\]|h-\[4rem\]/)![0]))

        const plain = renderCard(view({ name: 'ABCDE' }))
        const busy = renderCard(view({
            id: 'v2',
            name: 'Perf-Load-Test-Solidatus Lineage With A Very Long Name',
            description: 'This is my super duper cool cool not so cool but maybe so cool description',
            tags: ['abcdef', 'ghijkl'],
        }))
        expect(skeleton(busy.container)).toEqual(skeleton(plain.container))
    })

    it('keeps the reserves out of the way in compact density', () => {
        // Compact deliberately drops the preview and the description, so the
        // reserves that exist to align them must go with it — otherwise dense
        // mode pays for alignment it no longer has.
        const { container } = render(
            <MemoryRouter>
                <ExplorerViewCard
                    view={view()}
                    onToggleFavourite={noop}
                    onShare={noop}
                    onPreview={vi.fn()}
                    density="compact"
                />
            </MemoryRouter>,
        )
        expect(previewFrame(container)).toBeNull()
        expect(container.querySelector('.min-h-\\[2\\.5rem\\]')).toBeNull()
        const heading = container.querySelector('h3') as HTMLElement
        expect([...heading.classList]).not.toContain('min-h-[2.1875rem]')
        expect(within(container).getByText('Impact Analysis')).toBeInTheDocument()
    })
})
