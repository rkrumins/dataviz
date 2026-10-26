/**
 * toolbarFold — the header's actions fold their words away, least-used
 * first, when the row can't hold them beside the search box.
 *
 * The row is shared with the branch switcher and the search box, and the
 * Advanced Search panel beside the canvas takes 380–900px of the page. The
 * labelled actions need about 1,000px in View and more in Edit, which an
 * ordinary laptop with the panel open doesn't have: they ran past the
 * canvas edge — Edit, Import / Export and Properties out of reach — and the
 * search box, squeezed below the width of its own controls, painted them
 * over its neighbours.
 *
 * Now an action shows its icon alone when there's no room for its words —
 * keeping its tooltip and its accessible name — in a fixed order, the
 * least-used first. When every label is folded and the actions still don't
 * fit beside a usable search box, they move to a line of their own under it.
 *
 * Widths are read from the DOM, never guessed: a label is measured while it
 * shows and its width kept while it's folded, so it comes back the moment
 * there's room. An unmeasured row (jsdom, a first frame) folds nothing.
 */
import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type RefObject } from 'react'


/** Folded first to last. Done has no icon and never folds; Import / Export
 *  folds its words by itself below 2000px. */
export const FOLD_ORDER = [
    'undo', 'redo', 'select', 'lens', 'properties', 'display', 'lineage', 'trace', 'edit', 'review',
] as const
export type ToolbarItem = typeof FOLD_ORDER[number]

/** Room the search box keeps before a label folds, and the least it gets
 *  before the actions move under it — its own controls take about 144px. */
export const SEARCH_ROOM = 240
export const SEARCH_MIN = 160

/** How much room a folded label needs to spare before it comes back, so
 *  two measurements a pixel apart can never make the row flicker. */
const UNFOLD_SLACK = 8

/** A folded action's side padding (`px-2.5`). The actions animate their
 *  colours, not their padding (`transition`, not `transition-all`), so a
 *  width read off the page is never one caught mid-fold. */
const FOLDED_PAD = 10

export interface ToolbarFold {
    folded: ReadonlySet<string>
    /** The actions sit on a line of their own, under the search box. */
    stacked: boolean
}

const NONE: ToolbarFold = { folded: new Set(), stacked: false }


/**
 * Which labels fold, and whether the actions move under the search box.
 * `labelled` is the actions' width with every label showing; `items` are
 * the actions present, in fold order, with what folding each one saves.
 * The search box keeps `SEARCH_ROOM` while a label can still fold; past
 * that it gives way to `SEARCH_MIN`, and past that the actions stack.
 */
export function foldToolbar({ row, lead, gap, labelled, items }: {
    row: number
    /** What sits left of the search box: the branch switcher. */
    lead: number
    /** The row's gap between its three tracks. */
    gap: number
    labelled: number
    items: readonly { id: string; saving: number }[]
}): ToolbarFold {
    if (row <= 0 || labelled <= 0) return NONE
    const fold = (room: number) => {
        const folded = new Set<string>()
        let width = labelled
        for (const item of items) {
            if (width <= room) break
            width -= item.saving
            folded.add(item.id)
        }
        return { folded, fits: width <= room }
    }
    const beside = (search: number) => row - lead - search - 2 * gap
    const roomy = fold(beside(SEARCH_ROOM))
    if (roomy.fits) return { folded: roomy.folded, stacked: false }
    if (fold(beside(SEARCH_MIN)).fits) return { folded: new Set(items.map((i) => i.id)), stacked: false }
    return { folded: fold(row).folded, stacked: true }
}


/** How folded a decision is: each folded label a step, stacking past all. */
const level = (f: ToolbarFold) => (f.stacked ? 1000 : 0) + f.folded.size

/** The actions' width laid out on one line, wrapped or not. */
function naturalWidth(actions: HTMLElement): number {
    const cluster = actions.firstElementChild as HTMLElement | null
    if (!cluster) return 0
    const items = [...cluster.children] as HTMLElement[]
    const gap = parseFloat(getComputedStyle(cluster).columnGap) || 0
    return items.reduce((sum, el) => sum + el.getBoundingClientRect().width, 0) + gap * Math.max(0, items.length - 1)
}


/**
 * Measures the row and decides again whenever it, or the actions, change
 * size. `actions` holds the cluster; each foldable action carries
 * `data-toolbar-item` and its words `data-toolbar-label`, hidden with
 * `sr-only` while folded — which labels are folded is read off the page,
 * so a measurement taken before a new decision has rendered still adds up.
 *
 * Folding further applies at once; folding back waits until there is
 * `UNFOLD_SLACK` to spare.
 */
export function useToolbarFold(
    rowRef: RefObject<HTMLElement | null>,
    leadRef: RefObject<HTMLElement | null>,
    actionsRef: RefObject<HTMLElement | null>,
): ToolbarFold {
    const [fold, setFold] = useState<ToolbarFold>(NONE)
    const current = useRef(NONE)
    const savings = useRef(new Map<string, number>())

    const measure = useCallback(() => {
        const row = rowRef.current
        const actions = actionsRef.current
        const rowWidth = row?.clientWidth ?? 0
        if (!row || !actions || !rowWidth) return
        const present: string[] = []
        let hidden = 0
        for (const el of actions.querySelectorAll<HTMLElement>('[data-toolbar-item]')) {
            const id = el.dataset.toolbarItem as string
            const label = el.querySelector<HTMLElement>('[data-toolbar-label]')
            if (!label) continue
            present.push(id)
            if (label.classList.contains('sr-only')) {
                hidden += savings.current.get(id) ?? 0
                continue
            }
            const style = getComputedStyle(el)
            savings.current.set(id, label.getBoundingClientRect().width + (parseFloat(style.columnGap) || 0)
                + 2 * Math.max(0, (parseFloat(style.paddingLeft) || 0) - FOLDED_PAD))
        }
        const decide = (room: number) => foldToolbar({
            row: room,
            lead: leadRef.current?.scrollWidth ?? 0,
            gap: parseFloat(getComputedStyle(row).columnGap) || 0,
            labelled: naturalWidth(actions) + hidden,
            items: FOLD_ORDER.filter((id) => present.includes(id))
                .map((id) => ({ id, saving: savings.current.get(id) ?? 0 })),
        })
        const tight = decide(rowWidth)
        const loose = decide(rowWidth - UNFOLD_SLACK)
        const next = level(tight) > level(current.current) ? tight
            : level(loose) < level(current.current) ? loose
                : null
        if (!next) return
        current.current = next
        setFold(next)
    }, [rowRef, leadRef, actionsRef])

    useLayoutEffect(() => {
        measure()
        const row = rowRef.current
        const actions = actionsRef.current
        if (!row || typeof ResizeObserver !== 'function') return
        const ro = new ResizeObserver(() => measure())
        ro.observe(row)
        if (actions) ro.observe(actions)
        return () => ro.disconnect()
    }, [measure, rowRef, actionsRef])

    return fold
}


const FoldContext = createContext<ReadonlySet<string>>(NONE.folded)

/** Hands the folded actions to the buttons in the cluster. */
export const ToolbarFoldProvider = FoldContext.Provider

/** Whether this action shows its icon alone. Off outside the header. */
export function useFolded(id: ToolbarItem): boolean {
    return useContext(FoldContext).has(id)
}
