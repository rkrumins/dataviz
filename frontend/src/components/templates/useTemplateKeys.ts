/**
 * The Templates library, from the keyboard.
 *
 * `/` searches, `n` starts a new template, `i` imports one from a file. Once a
 * card has focus, the arrows move between cards — up and down by a whole row,
 * however many columns the grid has — Enter opens the focused one, `u` starts
 * a view from it and `f` makes it a favorite, or not. `?` lists all of this,
 * instead of the Help drawer it opens elsewhere.
 *
 * Never while someone is typing, holding a modifier, in a menu that owns its
 * keys, or in a dialog.
 */
import { useEffect, type RefObject } from 'react'
import type { ShortcutGroup } from '@/components/explorer/KeyboardShortcutsDialog'
import { isInKeyboardScope } from '@/lib/keyboardScope'

export const TEMPLATE_SHORTCUTS: ShortcutGroup[] = [
    {
        title: 'Library',
        items: [
            { keys: ['/'], label: 'Search templates' },
            { keys: ['n'], label: 'New template' },
            { keys: ['i'], label: 'Import a template file' },
            { keys: ['?'], label: 'Show this help' },
        ],
    },
    {
        title: 'Cards',
        items: [
            { keys: ['↑', '↓', '←', '→'], label: 'Move between templates', hint: 'Once a card has focus' },
            { keys: ['Enter'], label: 'Open the focused template' },
            { keys: ['u'], label: 'Start a view from it' },
            { keys: ['f'], label: 'Favorite it, or not' },
        ],
    },
]

const CARD = '[data-template-card]'
const GRID = '[data-template-grid]'
const STEP: Record<string, 'left' | 'right' | 'up' | 'down'> = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
}

const typing = (el: EventTarget | null) =>
    el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))

/** How many cards share the first card's row. */
function columns(cards: HTMLElement[]): number {
    const n = cards.findIndex(c => c.offsetTop !== cards[0].offsetTop)
    return n === -1 ? cards.length : n
}

export function useTemplateKeys({ rootRef, onSearch, onNew, onImport, onHelp, onOpen, onUse, onFavourite }: {
    rootRef: RefObject<HTMLElement | null>
    onSearch: () => void
    onNew: () => void
    onImport: () => void
    onHelp: () => void
    /** These act on the focused card's template. */
    onOpen: (templateId: string) => void
    onUse: (templateId: string) => void
    onFavourite: (templateId: string) => void
}) {
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
            if (typing(e.target) || isInKeyboardScope(e.target)) return
            // A dialog, the drawer or the studio has the keyboard. The drawer stays
            // mounted while closed, hidden.
            if (document.querySelector('[aria-modal="true"]:not([aria-hidden="true"])')) return
            const root = rootRef.current
            if (!root) return

            const commands: Record<string, () => void> = { '/': onSearch, n: onNew, i: onImport, '?': onHelp }
            const command = commands[e.key]
            if (command) {
                e.preventDefault()
                // AppLayout listens on window for "?": this page answers it instead.
                if (e.key === '?') e.stopPropagation()
                command()
                return
            }

            const active = document.activeElement
            const card = active instanceof Element && root.contains(active) ? active.closest<HTMLElement>(CARD) : null
            const id = card?.dataset.templateCard
            if (!card || !id) return
            if (e.key === 'Enter' && active === card) {
                e.preventDefault()
                onOpen(id)
            } else if (e.key === 'u') {
                e.preventDefault()
                onUse(id)
            } else if (e.key === 'f') {
                e.preventDefault()
                onFavourite(id)
            } else if (STEP[e.key]) {
                const cards = [...(card.closest(GRID) ?? root).querySelectorAll<HTMLElement>(CARD)]
                const at = cards.indexOf(card)
                const cols = columns(cards)
                const by = { left: -1, right: 1, up: -cols, down: cols }[STEP[e.key]]
                const next = cards[Math.min(cards.length - 1, Math.max(0, at + by))]
                e.preventDefault()
                next.focus({ preventScroll: true })
                next.scrollIntoView?.({ block: 'nearest' })
            }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
    }, [rootRef, onSearch, onNew, onImport, onHelp, onOpen, onUse, onFavourite])
}
