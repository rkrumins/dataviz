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
import { useSearchStore } from '@/store/searchStore'


export type ScopeMode = 'visible' | 'view' | 'data_source'


interface ModeMeta {
    label: string
    sub: string
    icon: typeof Eye
    tone: string
}


const MODES: Record<ScopeMode, ModeMeta> = {
    visible: {
        label: 'Visible nodes',
        sub: 'only what’s on the canvas right now',
        icon: Eye,
        tone: 'text-accent-lineage',
    },
    view: {
        label: 'All nodes in this view',
        sub: 'including collapsed folders inside the view',
        icon: LayersIcon,
        tone: 'text-emerald-300',
    },
    data_source: {
        label: 'Entire data source',
        sub: 'crosses this view’s boundary — power-user mode',
        icon: Globe2,
        tone: 'text-amber-300',
    },
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

    return (
        <>
            <div ref={containerRef} className="relative inline-flex">
                <button
                    type="button"
                    onClick={() => setOpen((v) => !v)}
                    className={cn(
                        'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md',
                        'text-[10.5px] font-medium leading-none',
                        'border border-glass-border/60 bg-canvas-base/40',
                        'hover:bg-canvas-base/70 hover:border-glass-border transition-colors',
                        meta.tone,
                    )}
                    title="Choose where the search runs"
                    aria-expanded={open}
                >
                    <ActiveIcon className="w-3 h-3" strokeWidth={2.2} />
                    <span className="text-ink-muted leading-none">Scope:</span>
                    <span className="leading-none">{meta.label}</span>
                    <ChevronDown
                        className={cn('w-3 h-3 text-ink-muted/80 transition-transform', open && 'rotate-180')}
                        strokeWidth={2.2}
                    />
                </button>
                {open && (
                    <div
                        className={cn(
                            'absolute left-0 top-full mt-1 z-30 w-72',
                            'rounded-lg border border-glass-border bg-canvas-elevated/95',
                            'backdrop-blur-md shadow-xl shadow-black/30 py-1',
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
                                        'w-full text-left flex items-start gap-2.5 px-3 py-2',
                                        'transition-colors',
                                        active
                                            ? 'bg-accent-lineage/10 text-ink'
                                            : 'text-ink/90 hover:bg-glass/30',
                                    )}
                                >
                                    <Icon className={cn('w-3.5 h-3.5 mt-0.5 shrink-0', m.tone)} strokeWidth={2.2} />
                                    <div className="flex flex-col min-w-0">
                                        <span className="text-[12px] font-medium leading-tight">
                                            {m.label}
                                            {active && <span className="ml-1.5 text-accent-lineage">✓</span>}
                                        </span>
                                        <span className="text-[10.5px] text-ink-muted/80 leading-snug">
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <div className={cn(
                'w-[420px] max-w-[90vw] rounded-2xl',
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
    )
}
