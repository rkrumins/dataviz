/**
 * RowMenu — per-row "⋯" actions menu shown on every leaf and group.
 *
 * Lets the user grow / reshape the tree without leaving the row:
 *
 *   ⋯ ┌─ Wrap in AND group ───────╮
 *      │ Wrap in OR group         │
 *      │ Wrap in NOT group        │
 *      │ ──                       │
 *      │ Duplicate                │
 *      │ ──                       │
 *      │ Delete                   │
 *      ╰──────────────────────────╯
 *
 * Portalled to ``document.body`` so it always overlays sibling cards.
 *
 * Wrap actions are the answer to "I have these flat conditions, how do
 * I group some of them?" — the user iteratively wraps a row into a
 * group then adds siblings into that group via the inline AddRowButton.
 * Matches the Notion / Linear / Airtable filter builder pattern.
 */
import { AnimatePresence, motion } from 'framer-motion'
import {
    Copy,
    MoreHorizontal,
    Parentheses,
    Trash2,
} from 'lucide-react'
import { type FC, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/lib/utils'

import { OP_HINTS, TONE_STYLES, type OpTone } from './tones'


export interface RowMenuProps {
    onWrap: (op: OpTone) => void
    onDuplicate: () => void
    onDelete: () => void
    disabled?: boolean
}


export const RowMenu: FC<RowMenuProps> = ({
    onWrap, onDuplicate, onDelete, disabled,
}) => {
    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)
    const [coords, setCoords] = useState<{ top: number; right: number } | null>(null)

    useLayoutEffect(() => {
        if (!open) { setCoords(null); return }
        const update = () => {
            const r = buttonRef.current?.getBoundingClientRect()
            if (!r) return
            const top = r.bottom + 4
            const right = window.innerWidth - r.right
            setCoords({ top, right })
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
            window.removeEventListener('resize', update)
            window.removeEventListener('scroll', update, true)
        }
    }, [open])

    useEffect(() => {
        if (!open) return
        const onClick = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return
            if (buttonRef.current?.contains(e.target as Node)) return
            setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onClick)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onClick)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                title="Row actions"
                className={cn(
                    'inline-flex items-center justify-center w-6 h-6 rounded-md',
                    'text-ink-muted/70 hover:text-ink hover:bg-glass/40',
                    'transition-colors',
                    open && 'text-ink bg-glass/40',
                )}
            >
                <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
            {open && coords && createPortal((
                <AnimatePresence>
                    <motion.div
                        ref={popoverRef}
                        initial={{ opacity: 0, y: -4, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.98 }}
                        transition={{ duration: 0.12 }}
                        style={{
                            position: 'fixed',
                            top: coords.top,
                            right: coords.right,
                            zIndex: 9999,
                        }}
                        className={cn(
                            'min-w-[200px] rounded-xl border border-glass-border',
                            'bg-canvas-elevated shadow-2xl shadow-black/50',
                            'flex flex-col py-1',
                        )}
                    >
                        <MenuSectionLabel>Wrap this row in a group</MenuSectionLabel>
                        {(['and', 'or', 'not'] as OpTone[]).map((op) => {
                            const meta = TONE_STYLES[op]
                            return (
                                <MenuItem
                                    key={op}
                                    onSelect={() => { onWrap(op); setOpen(false) }}
                                    icon={<Parentheses className={cn('w-3.5 h-3.5', meta.ink)} strokeWidth={2} />}
                                >
                                    <span className="flex-1 flex items-center gap-1.5">
                                        <span>Wrap in</span>
                                        <span className={cn(
                                            'inline-flex items-center gap-0.5 px-1.5 py-0 rounded',
                                            'text-[9px] font-semibold uppercase tracking-wider',
                                            meta.ink,
                                            'bg-canvas-base/50',
                                        )}>
                                            {meta.label}
                                            <span className="opacity-50 text-[8.5px]">{meta.sub}</span>
                                        </span>
                                        <span>group</span>
                                    </span>
                                </MenuItem>
                            )
                        })}
                        <MenuDivider />
                        <MenuItem
                            onSelect={() => { onDuplicate(); setOpen(false) }}
                            icon={<Copy className="w-3.5 h-3.5 text-ink-muted" strokeWidth={2} />}
                        >
                            Duplicate
                        </MenuItem>
                        <MenuDivider />
                        <MenuItem
                            onSelect={() => { onDelete(); setOpen(false) }}
                            icon={<Trash2 className="w-3.5 h-3.5 text-rose-400" strokeWidth={2} />}
                            danger
                        >
                            Delete
                        </MenuItem>
                        <MenuFooterHint>
                            ⌥ NOT inverts — useful for "everything except…" patterns
                        </MenuFooterHint>
                    </motion.div>
                </AnimatePresence>
            ), document.body)}
        </>
    )
}


function MenuItem({
    onSelect, icon, danger, children,
}: {
    onSelect: () => void
    icon: React.ReactNode
    danger?: boolean
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'w-full text-left flex items-center gap-2 px-3 py-1.5',
                'text-[12px] transition-colors',
                danger
                    ? 'text-rose-300 hover:bg-rose-500/15'
                    : 'text-ink hover:bg-glass/30',
            )}
        >
            <span className="shrink-0">{icon}</span>
            {children}
        </button>
    )
}


function MenuSectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <div className={cn(
            'px-3 pt-1.5 pb-1 text-[9px] font-semibold uppercase',
            'tracking-[0.14em] text-ink-muted/70',
        )}>
            {children}
        </div>
    )
}


function MenuDivider() {
    return <div className="my-1 mx-2 border-t border-glass-border/40" />
}


function MenuFooterHint({ children }: { children: React.ReactNode }) {
    void OP_HINTS  // imported for the tone semantics reference
    return (
        <div className={cn(
            'px-3 pt-1 pb-1.5 text-[10px] text-ink-muted/70',
            'border-t border-glass-border/30 mt-1',
        )}>
            {children}
        </div>
    )
}
