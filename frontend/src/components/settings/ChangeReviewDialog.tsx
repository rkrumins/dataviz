/**
 * ChangeReviewDialog — the one place a settings change is saved.
 *
 * It lists every staged value from → to with when it takes effect and what it changes; shows the
 * server's full preview of the impact (the page passes it in: graphs whose behaviour changes,
 * memory, readers, the database, drafts); asks the person to acknowledge each warning; and asks
 * why, because every change set is recorded with its reason. Save stays off until all of that is
 * done, and while the impact is still being worked out, since its warnings aren't known yet. When
 * the impact can't be worked out, saving without it is a choice the person makes explicitly. A
 * refused save says why; a version conflict offers to reload and re-apply the changes.
 */
import { useId, useState, type ReactNode } from 'react'
import { ArrowRight, RotateCcw, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { Field } from '@/components/ui/Field'
import { fieldControlProps, useField } from '@/components/ui/fieldContext'
import { Skeleton } from '@/components/ui/Skeleton'
import { ImpactChips } from './ImpactChips'
import type { ReviewItem } from './review'
import type { DimensionInfo } from './types'

export interface ReviewWarning {
    id: string
    text: ReactNode
    /** What ticking it says: "I understand" by default. */
    confirm?: string
}

export interface ChangeReviewDialogProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    items: ReviewItem[]
    /** Where the changes apply: "this graph". */
    where?: string
    dimensions?: DimensionInfo[]
    /** The full preview, drawn by the page. */
    impact?: ReactNode
    /** The impact is being worked out: Save waits for it, as its warnings aren't known yet. */
    impactLoading?: boolean
    /** The impact couldn't be worked out: Save needs "Save without seeing what this changes". */
    impactFailed?: boolean
    /** Each must be acknowledged before saving. */
    warnings?: ReviewWarning[]
    onSave: (reason: string) => void | Promise<void>
    saving?: boolean
    /** Why the save was refused. */
    error?: ReactNode
    /** Offered with `error` after a version conflict. */
    onReapply?: () => void
}

/** The acknowledgement a failed impact asks for, among the warnings. */
const UNSEEN = 'impact_unavailable'
const UNSEEN_WARNING: ReviewWarning = {
    id: UNSEEN,
    text: 'What this changes couldn’t be worked out, so any warning it would raise isn’t shown here. The values are still checked when they are saved.',
    confirm: 'Save without seeing what this changes',
}

function ReasonBox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
    const wiring = fieldControlProps(useField(), { required: true })
    return (
        <textarea
            {...wiring}
            rows={2}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="For example: large imports were slowing canvases for the sales team"
            className={cn(
                'w-full resize-y rounded-xl border border-glass-border/80 bg-canvas px-3 py-2 text-sm text-ink',
                'placeholder:text-ink-muted outline-none transition-[border-color,box-shadow] duration-150',
                'focus:border-accent-lineage/60 focus:ring-2 focus:ring-accent-lineage/25',
            )}
        />
    )
}

function Heading({ id, children }: { id?: string; children: ReactNode }) {
    return <h3 id={id} className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">{children}</h3>
}

export function ChangeReviewDialog({
    open, onOpenChange, items, where, dimensions = [], impact, impactLoading = false, impactFailed = false, warnings = [], onSave,
    saving = false, error, onReapply,
}: ChangeReviewDialogProps) {
    const id = useId()
    const [reason, setReason] = useState('')
    const [acknowledged, setAcknowledged] = useState<Record<string, boolean>>({})
    // A new try at the impact asks again: saving without it was agreed to for the one that failed.
    const [wasLoading, setWasLoading] = useState(impactLoading)
    if (wasLoading !== impactLoading) {
        setWasLoading(impactLoading)
        if (impactLoading && acknowledged[UNSEEN]) setAcknowledged((a) => ({ ...a, [UNSEEN]: false }))
    }
    const shown = impactFailed && !impactLoading ? [...warnings, UNSEEN_WARNING] : warnings
    const unacknowledged = shown.filter((w) => !acknowledged[w.id]).length
    const ready = items.length > 0 && reason.trim().length > 0 && unacknowledged === 0 && !impactLoading && !saving
    const n = items.length
    const blocking = impactLoading
        ? 'Save waits for what this changes.'
        : !reason.trim()
            ? 'Say why to save.'
            : unacknowledged ? `Acknowledge ${unacknowledged === 1 ? 'the warning' : `${unacknowledged} warnings`} to save.` : ''

    return (
        <Dialog
            open={open}
            onOpenChange={onOpenChange}
            size="lg"
            dismissible={!saving}
            title={`Review ${n} ${n === 1 ? 'change' : 'changes'}${where ? ` to ${where}` : ''}`}
            description="Nothing is saved until you press Save. The change is recorded with your reason, and you can undo it."
            footer={(
                <>
                    {blocking && <p className="mr-auto text-xs text-ink-secondary">{blocking}</p>}
                    <Button variant="ghost" disabled={saving} onClick={() => onOpenChange(false)} className="text-ink-secondary">Keep editing</Button>
                    <Button variant="primary" loading={saving} disabled={!ready} onClick={() => { void onSave(reason.trim()) }}
                        className="bg-indigo-600 hover:bg-indigo-700 hover:brightness-100">
                        Save {n === 1 ? 'change' : `${n} changes`}
                    </Button>
                </>
            )}
        >
            <div className="space-y-6">
                <section aria-labelledby={`${id}-changes`} className="space-y-2.5">
                    <Heading id={`${id}-changes`}>What changes</Heading>
                    <ol className="space-y-2">
                        {items.map((item) => (
                            <li key={item.id ?? item.key} className="rounded-xl border border-glass-border/60 px-4 py-3">
                                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                    <p className="text-[13px] font-semibold text-ink">{item.label}</p>
                                    <p className="text-[11px] text-ink-secondary">{item.how}</p>
                                </div>
                                <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                                    <span className="text-ink-secondary line-through decoration-ink-muted/50">
                                        <span className="sr-only">From </span>{item.from}
                                    </span>
                                    <ArrowRight aria-hidden className="w-3.5 h-3.5 text-ink-muted" />
                                    <span className="font-semibold text-indigo-700 dark:text-indigo-300"><span className="sr-only">to </span>{item.to}</span>
                                </p>
                                <p className="mt-1 text-[11.5px] text-ink-secondary">{item.takesEffect}</p>
                                {item.impacts.length > 0 && dimensions.length > 0 && (
                                    <ImpactChips className="mt-2" impacts={item.impacts} dimensions={dimensions} label={`What changing ${item.label} does`} />
                                )}
                            </li>
                        ))}
                    </ol>
                </section>

                {(impact || impactLoading) && (
                    <section aria-labelledby={`${id}-impact`} aria-busy={impactLoading || undefined} className="space-y-2.5">
                        <Heading id={`${id}-impact`}>What it affects</Heading>
                        {impactLoading ? (
                            <div className="space-y-2" aria-label="Working out what this changes">
                                <Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-16 w-full" />
                            </div>
                        ) : impact}
                    </section>
                )}

                {shown.length > 0 && (
                    <section aria-labelledby={`${id}-warnings`} className="space-y-2.5">
                        <Heading id={`${id}-warnings`}>Before you save</Heading>
                        <ul className="space-y-2">
                            {shown.map((w) => (
                                <li key={w.id} className="rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-3">
                                    <label className="flex cursor-pointer items-start gap-3">
                                        <input
                                            type="checkbox"
                                            checked={Boolean(acknowledged[w.id])}
                                            onChange={(e) => setAcknowledged((a) => ({ ...a, [w.id]: e.target.checked }))}
                                            className="mt-0.5 h-4 w-4 shrink-0 accent-[rgb(var(--nx-accent-lineage-rgb))]"
                                        />
                                        <span className="text-[13px] leading-relaxed text-ink-secondary">
                                            <TriangleAlert aria-hidden className="mr-1.5 inline w-3.5 h-3.5 -mt-0.5 text-amber-600 dark:text-amber-400" />
                                            {w.text}
                                            <span className="mt-0.5 block text-[11.5px] font-semibold text-ink">{w.confirm ?? 'I understand'}</span>
                                        </span>
                                    </label>
                                </li>
                            ))}
                        </ul>
                    </section>
                )}

                <Field label="Why are you making this change?" help="Saved with the change in the history, for whoever reads it next." required>
                    <ReasonBox value={reason} onChange={setReason} />
                </Field>

                {error && (
                    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3">
                        <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">{error}</p>
                        {onReapply && (
                            <Button size="sm" variant="secondary" leftIcon={RotateCcw} onClick={onReapply}>Reload and re-apply my changes</Button>
                        )}
                    </div>
                )}
            </div>
        </Dialog>
    )
}
