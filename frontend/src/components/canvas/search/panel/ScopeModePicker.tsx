/**
 * ScopeModePicker — header chip that controls where the search runs.
 *
 *     [ Visible nodes ▾ ]
 *       ✓ Visible nodes          ← default
 *         All nodes in this view
 *         Entire data source     ← power-user
 *
 * Default ("Visible nodes") matches the user's mental model — search
 * the entities they actually see on the canvas. Switching to "All
 * nodes in this view" expands to the view's authorised scope (folders
 * the user has collapsed are included). "Entire data source" bypasses
 * the view boundary entirely — power-user mode with an inline
 * disclaimer.
 *
 * The store action ``setScopeMode`` updates the next-run scope; the
 * compiler reads ``scope.scope_mode`` + ``scope.visible_urns`` on the
 * BE.
 */
import { ChevronDown, Eye, Layers as LayersIcon, Globe2, AlertTriangle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { useSearchStore } from '@/store/searchStore'


export type ScopeMode = 'visible' | 'view' | 'data_source'


interface ModeMeta {
    label: string
    sub: string
    icon: typeof Eye
    tone: string
    /** Soft badge shown next to the label in the dropdown. */
    badge?: 'recommended' | 'slower' | 'power-user'
}


const MODES: Record<ScopeMode, ModeMeta> = {
    visible: {
        label: 'Visible nodes',
        sub: 'Only what’s on the canvas right now — narrow, fast, '
            + 'and skips any subtree you haven’t expanded yet.',
        icon: Eye,
        tone: 'text-emerald-300',
    },
    view: {
        label: 'All nodes in this view',
        sub: 'Includes descendants of every top-level node in this '
            + 'view, even ones you haven’t expanded yet — the default. '
            + 'Up to 256 top-level containers per query.',
        icon: LayersIcon,
        tone: 'text-accent-lineage',
        badge: 'recommended',
    },
    data_source: {
        label: 'Entire data source',
        sub: 'Crosses this view’s boundary. Results may include nodes '
            + 'that are not in this view.',
        icon: Globe2,
        tone: 'text-amber-300',
        badge: 'power-user',
    },
}


const BADGE_STYLES: Record<NonNullable<ModeMeta['badge']>, string> = {
    'recommended': 'bg-accent-lineage/15 text-accent-lineage',
    'slower': 'bg-emerald-500/15 text-emerald-300',
    'power-user': 'bg-amber-500/15 text-amber-300',
}


const BADGE_LABEL: Record<NonNullable<ModeMeta['badge']>, string> = {
    'recommended': 'Recommended',
    'slower': 'Slower',
    'power-user': 'Power-user',
}


export function ScopeModePicker() {
    const scopeMode = useSearchStore((s) => s.scopeMode)
    const setScopeMode = useSearchStore((s) => s.setScopeMode)
    const [open, setOpen] = useState(false)
    const [confirm, setConfirm] = useState<ScopeMode | null>(null)
    const containerRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        if (!open) return
        const handler = (e: MouseEvent) => {
            if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [open])

    const meta = MODES[scopeMode]
    const ActiveIcon = meta.icon

    function handlePick(mode: ScopeMode) {
        setOpen(false)
        if (mode === 'data_source' && scopeMode !== 'data_source') {
            setConfirm(mode)
            return
        }
        setScopeMode(mode)
    }

    // Tone classes (matches the active mode) — applied to the trigger
    // border + soft tonal background so the picker reads as a
    // first-class control, not a footnote.
    const triggerTone = scopeMode === 'view'
        ? 'border-accent-lineage/40 bg-accent-lineage/[0.06]'
        : scopeMode === 'visible'
            ? 'border-emerald-500/40 bg-emerald-500/[0.06]'
            : 'border-amber-500/45 bg-amber-500/[0.08]'

    return (
        <>
            <div ref={containerRef} className="relative inline-flex">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className={cn(
                        'inline-flex items-center gap-2 px-2.5 py-1.5 rounded-lg',
                        'text-[11.5px] font-semibold leading-tight',
                        'border transition-all',
                        triggerTone,
                        'hover:brightness-110',
                    )}
                    title="Choose where the search runs"
                    aria-expanded={open}
                >
                    <ActiveIcon className={cn('w-3.5 h-3.5', meta.tone)} strokeWidth={2.2} />
                    <span className="flex flex-col items-start leading-tight">
                        <span className="text-[9px] uppercase tracking-[0.12em] text-ink-muted/80 font-medium">
                            Search scope
                        </span>
                        <span className={cn('text-[12px]', meta.tone)}>
                            {meta.label}
                        </span>
                    </span>
                    <ChevronDown
                        className={cn(
                            'w-3.5 h-3.5 text-ink-muted/85 transition-transform shrink-0',
                            open && 'rotate-180',
                        )}
                        strokeWidth={2.2}
                    />
                </button>
                {open && (
                    <div
                        className={cn(
                            'absolute left-0 top-full mt-1.5 z-40 w-80',
                            // Solid background (no transparency) — matches the
                            // shadcn dropdown pattern used elsewhere in the
                            // panel. Previously bg-canvas-elevated/95 +
                            // backdrop-blur let underlying canvas + flow
                            // animations bleed through and made the menu
                            // unreadable when expanded.
                            'rounded-xl border border-glass-border',
                            'bg-canvas-elevated shadow-2xl shadow-black/50',
                            'ring-1 ring-white/5 py-1',
                        )}
                        role="listbox"
                    >
                        {(Object.keys(MODES) as ScopeMode[]).map((mode) => {
                            const m = MODES[mode]
                            const Icon = m.icon
                            const active = mode === scopeMode
                            return (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => handlePick(mode)}
                                    className={cn(
                                        'w-full text-left flex items-start gap-2.5 px-3 py-2.5',
                                        'transition-colors',
                                        active
                                            ? 'bg-accent-lineage/12'
                                            : 'hover:bg-glass/40',
                                    )}
                                >
                                    <span className={cn(
                                        'shrink-0 mt-0.5 inline-flex items-center justify-center',
                                        'w-6 h-6 rounded-md',
                                        active
                                            ? 'bg-accent-lineage/15'
                                            : 'bg-canvas-base/60',
                                    )}>
                                        <Icon className={cn('w-3.5 h-3.5', m.tone)} strokeWidth={2.2} />
                                    </span>
                                    <div className="flex flex-col min-w-0">
                                        <span className="inline-flex items-center gap-1.5">
                                            <span className={cn(
                                                'text-[12.5px] font-semibold leading-tight',
                                                active ? 'text-ink' : 'text-ink/95',
                                            )}>
                                                {m.label}
                                            </span>
                                            {m.badge && (
                                                <span className={cn(
                                                    'inline-flex items-center gap-0.5 px-1.5 py-0 rounded',
                                                    'text-[9px] font-semibold uppercase tracking-wider',
                                                    BADGE_STYLES[m.badge],
                                                )}>
                                                    {BADGE_LABEL[m.badge]}
                                                </span>
                                            )}
                                            {active && (
                                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wider bg-canvas-base/60 text-ink-muted">
                                                    Active
                                                </span>
                                            )}
                                        </span>
                                        <span className="text-[11px] text-ink-muted/85 leading-snug mt-0.5">
                                            {m.sub}
                                        </span>
                                    </div>
                                </button>
                            )
                        })}
                    </div>
                )}
            </div>
            {confirm && (
                <ScopeConfirmModal
                    mode={confirm}
                    onCancel={() => setConfirm(null)}
                    onConfirm={() => {
                        setScopeMode(confirm)
                        setConfirm(null)
                    }}
                />
            )}
        </>
    )
}


function ScopeConfirmModal({
    mode, onCancel, onConfirm,
}: {
    mode: ScopeMode
    onCancel: () => void
    onConfirm: () => void
}) {
    const m = MODES[mode]
    return (
        <>
        <Backdrop open={true} zClassName="z-50" className="bg-black/50 backdrop-blur-sm" />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className={cn(
                'pointer-events-auto w-[420px] max-w-[90vw] rounded-2xl',
                'bg-canvas-elevated border border-amber-500/40 shadow-2xl',
                'p-5 flex flex-col gap-4',
            )}>
                <div className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
                        <AlertTriangle className="w-4 h-4 text-amber-300" strokeWidth={2.2} />
                    </div>
                    <div className="flex flex-col gap-1">
                        <h3 className="text-[14px] font-display font-semibold text-ink">
                            Search the entire data source?
                        </h3>
                        <p className="text-[12px] text-ink-muted leading-relaxed">
                            Results will include entities that exist in the data
                            source but are <strong>not in this view</strong>. They
                            won&apos;t be highlighted on the canvas, but they will
                            appear in the results list. This is intended for
                            power-user inspection.
                        </p>
                    </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className={cn(
                            'px-3 py-1.5 rounded-md text-[12px] font-medium',
                            'text-ink-muted hover:text-ink hover:bg-glass/40 transition-colors',
                        )}
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={cn(
                            'px-3 py-1.5 rounded-md text-[12px] font-semibold',
                            'bg-amber-500/20 text-amber-100 border border-amber-500/40',
                            'hover:bg-amber-500/30 transition-colors',
                        )}
                    >
                        Enable {m.label.toLowerCase()}
                    </button>
                </div>
            </div>
        </div>
        </>
    )
}
