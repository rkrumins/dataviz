/**
 * What we store — resolved live, with its provenance.
 *
 * The old editor showed the candidate list and, behind a button, a small
 * `<dl>` of resolved values at the bottom of a long scroll. The two were
 * never on screen together, so the question an operator actually has —
 * *does this list produce that value?* — had to be held in their head.
 *
 * Here each field is one row carrying all three: the value it resolved to,
 * which key produced it, and the fallback chain with the winner marked.
 * A required field that resolved nothing says so in place, rather than as
 * a red sentence somewhere below.
 */
import { AlertCircle, Check, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FIELDS } from './fields'

export interface FieldRow {
    key: string
    label: string
    hint: string
    required?: boolean
    /** Ordered candidate keys currently in effect. */
    candidates: string[]
    /** Inheriting the kind default rather than overridden here. */
    inherited: boolean
    /** Which candidate supplied the value, from the server's provenance.
     *  `undefined` = not resolved yet (no sample); `null` = nothing matched. */
    winner?: string | null
    /** The resolved value, already formatted for display. */
    value?: string
}

export function ProfilePane({
    rows, pending, error, onRemoveCandidate, onAddCandidate, onRevert,
}: {
    rows: FieldRow[]
    pending: boolean
    /** A mapping that cannot resolve a required field. Rendered against the
     *  offending row when we can tell which, and above otherwise. */
    error: string | null
    onRemoveCandidate: (field: string, key: string) => void
    onAddCandidate: (field: string, key: string) => void
    onRevert: (field: string) => void
}) {
    return (
        <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2">
                <h4 className="text-xs font-semibold text-ink uppercase tracking-wider">
                    We store
                </h4>
                <span
                    aria-live="polite"
                    className={cn(
                        'text-[10px] transition-opacity duration-150',
                        pending ? 'opacity-100 text-ink-muted' : 'opacity-0',
                    )}
                >
                    resolving…
                </span>
            </div>
            <p className="mt-1 text-[11px] text-ink-muted">
                First key with a value wins. Drop the ones that never fire.
            </p>

            {error && !rows.some(r => r.required && r.winner === null) && (
                <p className="mt-3 flex items-start gap-1.5 text-[11px] text-red-500">
                    <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
                    {error}
                </p>
            )}

            <ul className="mt-3 space-y-2">
                {rows.map(r => (
                    <li key={r.key}>
                        <Row
                            row={r}
                            onRemoveCandidate={k => onRemoveCandidate(r.key, k)}
                            onAddCandidate={k => onAddCandidate(r.key, k)}
                            onRevert={() => onRevert(r.key)}
                        />
                    </li>
                ))}
            </ul>
        </div>
    )
}

function Row({
    row, onRemoveCandidate, onAddCandidate, onRevert,
}: {
    row: FieldRow
    onRemoveCandidate: (key: string) => void
    onAddCandidate: (key: string) => void
    onRevert: () => void
}) {
    // Distinguish "we have not resolved anything yet" from "we resolved and
    // nothing matched". A dash for both would read as a broken mapping when
    // the operator has simply not pasted a sample.
    const unresolved = row.winner === null
    const missingRequired = row.required && unresolved

    return (
        <div className={cn(
            'rounded-xl border p-2.5',
            missingRequired
                ? 'border-red-400/50 bg-red-500/[0.05]'
                : 'border-black/[0.08] dark:border-white/[0.10]',
        )}>
            <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold text-ink">
                    {row.label}
                    {row.required && (
                        <span aria-hidden="true" className="text-red-500 ml-0.5">*</span>
                    )}
                </span>
                {row.inherited ? (
                    <span className="text-[10px] text-ink-muted">default</span>
                ) : (
                    <button
                        type="button"
                        onClick={onRevert}
                        className="inline-flex items-center gap-1 text-[10px] text-indigo-500 hover:underline"
                    >
                        <RotateCcw className="w-2.5 h-2.5" /> use default
                    </button>
                )}
            </div>

            {/* The answer, first — this is what the pane exists to show. */}
            <div className="mt-1.5 min-h-[1.25rem]">
                {missingRequired ? (
                    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-red-500">
                        <AlertCircle className="w-3 h-3" />
                        Nothing resolved — sign-in would fail
                    </span>
                ) : unresolved ? (
                    <span className="text-[11px] text-ink-muted">
                        Nothing resolved
                    </span>
                ) : row.value !== undefined ? (
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                        <Check className="w-3 h-3 shrink-0 text-emerald-500" />
                        <span className="font-mono text-[11px] text-ink truncate">
                            {row.value || '(empty)'}
                        </span>
                        {row.winner && (
                            <span className="shrink-0 text-[10px] text-ink-muted">
                                from <code className="font-mono">{row.winner}</code>
                            </span>
                        )}
                    </span>
                ) : (
                    <span className="text-[11px] text-ink-muted">
                        Paste a sample to see this resolve
                    </span>
                )}
            </div>

            <CandidateChips
                candidates={row.candidates}
                winner={row.winner ?? undefined}
                onRemove={onRemoveCandidate}
                onAdd={onAddCandidate}
            />

            {row.hint && (
                <p className="mt-1.5 text-[10px] text-ink-muted">{row.hint}</p>
            )}
        </div>
    )
}

function CandidateChips({
    candidates, winner, onRemove, onAdd,
}: {
    candidates: string[]
    winner?: string
    onRemove: (key: string) => void
    onAdd: (key: string) => void
}) {
    return (
        <div className="mt-2 flex flex-wrap items-center gap-1">
            {candidates.map((c, i) => {
                const won = c === winner
                return (
                    <span
                        key={c}
                        className={cn(
                            'inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded border font-mono text-[10px]',
                            won
                                ? 'border-emerald-400/60 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                : 'border-black/[0.08] dark:border-white/[0.12] text-ink-muted',
                        )}
                    >
                        <span className="opacity-60">{i + 1}.</span>
                        {c}
                        <button
                            type="button"
                            aria-label={`Remove ${c}`}
                            onClick={() => onRemove(c)}
                            className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10"
                        >
                            <X className="w-2.5 h-2.5" />
                        </button>
                    </span>
                )
            })}
            <AddKey onAdd={onAdd} />
        </div>
    )
}

function AddKey({ onAdd }: { onAdd: (key: string) => void }) {
    return (
        <input
            placeholder="add a key…"
            aria-label="Add a source key"
            onBlur={e => {
                const v = e.target.value.trim()
                if (v) { onAdd(v); e.target.value = '' }
            }}
            onKeyDown={e => {
                if (e.key !== 'Enter' && e.key !== ',') return
                e.preventDefault()
                const el = e.currentTarget
                const v = el.value.trim()
                if (v) { onAdd(v); el.value = '' }
            }}
            className="min-w-[7rem] flex-1 px-1.5 py-0.5 rounded bg-canvas border border-black/[0.08] dark:border-white/[0.12] font-mono text-[10px]"
        />
    )
}

export { FIELDS }
