/**
 * The explorer, from the keyboard.
 *
 * `j` / `↓` and `k` / `↑` walk the timeline's rows (the arrows only once a row
 * has focus, so they still scroll the page otherwise), and Enter opens one, as
 * on any button. Walking past the last row loads the next page. With an event
 * open, `j` / `→` and `k` / `←` step to the next and previous row's event, so
 * a run of events reads without the mouse. `/` jumps to search; `?` lists all
 * of this.
 *
 * Never while someone is typing, holding a modifier, or in another dialog.
 */
import { useEffect, type RefObject } from 'react'

import type { ShortcutGroup } from '@/components/explorer/KeyboardShortcutsDialog'

export const ACTIVITY_SHORTCUTS: ShortcutGroup[] = [
    {
        title: 'Timeline',
        items: [
            { keys: ['j', '↓'], label: 'Next event' },
            { keys: ['k', '↑'], label: 'Previous event' },
            { keys: ['Enter'], label: 'Open it' },
            { keys: ['/'], label: 'Search what happened' },
        ],
    },
    {
        title: 'An open event',
        items: [
            { keys: ['j', '→'], label: 'Older event' },
            { keys: ['k', '←'], label: 'Newer event' },
            { keys: ['Esc'], label: 'Back to the timeline', hint: 'Where you left off' },
        ],
    },
]

const ROW = '[data-activity-row]'

const typing = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

/** A focused region wider than its box (the raw payload): its arrows scroll it. */
const scrollsSideways = (el: EventTarget | null) => el instanceof HTMLElement && el.scrollWidth > el.clientWidth

/** The row showing an event, if it is on screen. */
export const rowOf = (root: HTMLElement | null, id: string) =>
    [...(root?.querySelectorAll<HTMLElement>(ROW) ?? [])].find((el) => el.dataset.activityRow === id) ?? null

export function useActivityKeys({ rootRef, eventId, step, onStep, onHelp, onEnd }: {
    rootRef: RefObject<HTMLElement | null>
    /** The event open in the drawer. */
    eventId: string | null
    /** The rows either side of the open event, in timeline order. */
    step: { newer: string | null; older: string | null }
    onStep: (id: string) => void
    onHelp: () => void
    /** Walked past the last row. */
    onEnd: () => void
}) {
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || typing(e.target)) return
            const root = rootRef.current
            if (!root) return

            if (eventId) {
                if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && scrollsSideways(e.target)) return
                const to = e.key === 'j' || e.key === 'ArrowRight' ? step.older
                    : e.key === 'k' || e.key === 'ArrowLeft' ? step.newer
                        : undefined
                if (to === undefined) return
                e.preventDefault()
                if (to) onStep(to)
                return
            }
            // Another dialog has the keyboard: this sheet, a reason prompt.
            if (document.querySelector('[aria-modal="true"]')) return

            if (e.key === '/') {
                const search = root.querySelector<HTMLInputElement>('[data-activity-search]')
                if (search && !search.disabled) {
                    e.preventDefault()
                    search.focus()
                }
                return
            }
            if (e.key === '?') {
                e.preventDefault()
                onHelp()
                return
            }

            const rows = [...root.querySelectorAll<HTMLElement>(ROW)]
            const at = rows.indexOf(document.activeElement as HTMLElement)
            const down = e.key === 'j' || (e.key === 'ArrowDown' && at >= 0)
            const up = e.key === 'k' || (e.key === 'ArrowUp' && at >= 0)
            if (rows.length === 0 || (!down && !up)) return
            e.preventDefault()
            if (down && at === rows.length - 1) onEnd()
            const next = rows[at < 0 ? 0 : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)))]
            next.focus({ preventScroll: true })
            next.scrollIntoView?.({ block: 'nearest' })
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [rootRef, eventId, step.newer, step.older, onStep, onHelp, onEnd])
}
