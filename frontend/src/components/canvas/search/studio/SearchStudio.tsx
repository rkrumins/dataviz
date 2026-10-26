/**
 * SearchStudio — the search panel opened out over the canvas: the query
 * on the left, its answer in the middle as a table with room to read it,
 * and what the view holds on the right, counted exactly.
 *
 * It covers the region the panel and its canvas share — portaled, so no
 * clipped or blurred column holds it, and opaque, so the canvas behind is
 * neither seen nor reachable (it is made inert), and the canvas's shortcuts
 * leave the keys typed in it alone. The app around it stays in reach, so it
 * is a dialog but not a modal one. It fades in and simply unmounts: there
 * is no exit to strand it. Esc closes it unless a popover is open; the
 * panel keeps the one query card while it is.
 *
 * Narrower than 1280px the inspector becomes a drawer; narrower than
 * 1024px the three become tabs.
 */
import { motion } from 'framer-motion'
import { Database, Minimize2, Sparkles } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { DocsLink } from '@/components/help/DocsLink'
import { IconButton } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Segmented'
import { keyboardScopeProps } from '@/lib/keyboardScope'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'

import { useHostRect } from './useHostRect'


type Pane = 'builder' | 'results' | 'inspector'

const PANES: { value: Pane; label: string }[] = [
    { value: 'builder', label: 'Query' },
    { value: 'results', label: 'Results' },
    { value: 'inspector', label: 'Inspector' },
]


export interface SearchStudioProps {
    /** The region to cover — the panel's and its canvas's. */
    host: Element | null
    onClose: () => void
    builder: ReactNode
    results: ReactNode
    inspector: ReactNode
}


export function SearchStudio({ host, onClose, builder, results, inspector }: SearchStudioProps) {
    const rect = useHostRect(host)
    const rootRef = useRef<HTMLDivElement>(null)
    const [tab, setTab] = useState<Pane>('builder')
    const [drawer, setDrawer] = useState(false)
    const width = rect?.width ?? window.innerWidth
    const layout = width >= 1280 ? 'three' : width >= 1024 ? 'two' : 'tabs'

    // What the Studio covers can't be reached while it does.
    useEffect(() => {
        if (!host) return
        host.setAttribute('inert', '')
        return () => host.removeAttribute('inert')
    }, [host])

    // Focus moves into it: to the field an empty card starts in, else the
    // top; Tab goes on from there.
    useEffect(() => {
        const frame = requestAnimationFrame(() => {
            if (!rootRef.current?.contains(document.activeElement)) rootRef.current?.focus()
        })
        return () => cancelAnimationFrame(frame)
    }, [])

    // Esc closes it: pressed in it, or with focus fallen to the page when
    // the control that held it went away. A popover's Esc is its own, and
    // the canvas behind doesn't take the press too.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return
            const at = document.activeElement
            const fallen = !at || at === document.body
            // Focus elsewhere in the app: not its press. A control in it
            // that took the press keeps it — the canvas's keys mark every
            // Esc they see, so only a press from inside is read that way.
            if (!fallen && (!rootRef.current?.contains(at) || e.defaultPrevented)) return
            if (document.querySelector('[data-radix-popper-content-wrapper], [data-floating-layer]')) return
            e.preventDefault()
            e.stopPropagation()
            onClose()
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [onClose])

    const section = 'flex min-h-0 flex-col gap-3 p-4'
    return createPortal(
        <motion.div
            ref={rootRef}
            role="dialog"
            aria-label="Search Studio"
            tabIndex={-1}
            data-search-studio=""
            {...keyboardScopeProps('search-studio')}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={MOTION.fadeIn}
            className="fixed z-40 flex flex-col bg-canvas-base text-ink shadow-2xl outline-none"
            style={rect ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
                : { top: 0, left: 0, right: 0, bottom: 0 }}
        >
            <header className="flex shrink-0 items-center gap-3 border-b border-glass-border px-4 py-2.5">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent-lineage/15">
                    <Sparkles className="h-4 w-4 text-accent-lineage" aria-hidden />
                </span>
                <h2 className="font-display text-base font-semibold">Search Studio</h2>
                {layout === 'tabs' && (
                    <Segmented options={PANES} value={tab} onChange={setTab} label="Which pane" size="sm" />
                )}
                <div className="ml-auto flex items-center gap-1.5">
                    <DocsLink slug="advanced-search" newTab label="Guide" className="mr-1.5 text-xs" />
                    {layout === 'two' && (
                        <IconButton icon={Database} label={drawer ? 'Hide the inspector' : 'Show what the view holds'}
                                    active={drawer} onClick={() => setDrawer(!drawer)} />
                    )}
                    <IconButton icon={Minimize2} label="Back to the panel" shortcut="Esc" onClick={onClose} />
                </div>
            </header>

            <div className={cn('relative min-h-0 flex-1',
                layout === 'three' && 'grid grid-cols-[minmax(22rem,1fr)_minmax(26rem,1.5fr)_18rem]',
                layout === 'two' && 'grid grid-cols-[minmax(20rem,1fr)_minmax(24rem,1.4fr)]',
                layout === 'tabs' && 'flex flex-col')}>
                {(layout !== 'tabs' || tab === 'builder') && (
                    <section aria-label="Build the query"
                             className={cn(section, 'overflow-y-auto custom-scrollbar', layout !== 'tabs' && 'border-r border-glass-border')}>
                        {builder}
                    </section>
                )}
                {(layout !== 'tabs' || tab === 'results') && (
                    <section aria-label="The results" className={cn(section, 'min-w-0')}>{results}</section>
                )}
                {(layout === 'three' || (layout === 'tabs' && tab === 'inspector')) && (
                    <aside aria-label="What the view holds"
                           className={cn(section, layout === 'three' && 'border-l border-glass-border bg-canvas-elevated/40')}>
                        {inspector}
                    </aside>
                )}
                {layout === 'two' && drawer && (
                    <aside aria-label="What the view holds"
                           className={cn(section, 'absolute bottom-0 right-0 top-0 w-80 border-l border-glass-border bg-canvas-elevated shadow-2xl')}>
                        {inspector}
                    </aside>
                )}
            </div>
        </motion.div>,
        document.body,
    )
}
