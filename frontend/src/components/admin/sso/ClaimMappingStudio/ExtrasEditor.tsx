/**
 * Extra attributes — anything worth keeping that is not a profile field.
 *
 * Carried over from `ClaimMappingEditor` largely intact: it was the one
 * part of the old editor whose shape was right, because an extra is a
 * name-you-chose plus a candidate list, and there is no second pane to
 * relate it to. Restyled to match the studio and nothing more.
 *
 * These land in `users.metadata_.attributes` and the indexed
 * `user_external_attributes` table, which is what makes Diagnostics able to
 * find someone by staff number. They are never read for access decisions.
 */
import { useState } from 'react'
import { Plus, X } from 'lucide-react'

export function ExtrasEditor({
    extras, onChange,
}: {
    extras: Record<string, string[]>
    onChange: (next: Record<string, string[]>) => void
}) {
    const [newKey, setNewKey] = useState('')
    const rows = Object.entries(extras)

    function rename(from: string, to: string) {
        const trimmed = to.trim()
        if (!trimmed || trimmed === from || trimmed in extras) return
        const next: Record<string, string[]> = {}
        for (const [k, v] of Object.entries(extras)) {
            next[k === from ? trimmed : k] = v
        }
        onChange(next)
    }

    return (
        <div className="pt-3 border-t border-black/[0.08] dark:border-white/[0.10] space-y-2">
            <div>
                <h5 className="text-[11px] font-semibold text-ink">Extra attributes</h5>
                <p className="text-[10px] text-ink-muted">
                    Anything else worth keeping — department, employee ID, cost
                    centre. Stored on the user and indexed, so admins can find
                    people by these values. Never used for access decisions.
                </p>
            </div>

            {rows.map(([key, candidates]) => (
                <div key={key} className="grid grid-cols-[10rem_1fr_auto] gap-2 items-start">
                    <input
                        defaultValue={key}
                        onBlur={e => rename(key, e.target.value)}
                        aria-label="Attribute name"
                        className="px-2 py-1 rounded-lg bg-canvas border border-black/[0.10] dark:border-white/[0.12] font-mono text-[11px]"
                    />
                    <KeyList
                        values={candidates}
                        onChange={next => onChange({ ...extras, [key]: next })}
                    />
                    <button
                        type="button"
                        aria-label={`Remove attribute ${key}`}
                        onClick={() => {
                            const next = { ...extras }
                            delete next[key]
                            onChange(next)
                        }}
                        className="p-1 rounded text-ink-muted hover:bg-black/10 dark:hover:bg-white/10 hover:text-ink"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            ))}

            <div className="flex gap-2">
                <input
                    value={newKey}
                    onChange={e => setNewKey(e.target.value)}
                    placeholder="new attribute name, e.g. staff_id"
                    aria-label="New attribute name"
                    className="flex-1 px-2 py-1 rounded-lg bg-canvas border border-black/[0.10] dark:border-white/[0.12] font-mono text-[11px]"
                />
                <button
                    type="button"
                    onClick={() => {
                        const k = newKey.trim()
                        if (!k || k in extras) return
                        onChange({ ...extras, [k]: [] })
                        setNewKey('')
                    }}
                    className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border border-black/[0.10] dark:border-white/[0.12] text-[11px] text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                >
                    <Plus className="w-3 h-3" /> Add
                </button>
            </div>
        </div>
    )
}

function KeyList({
    values, onChange,
}: {
    values: string[]
    onChange: (next: string[]) => void
}) {
    const [draft, setDraft] = useState('')

    function add(raw: string) {
        const v = raw.trim()
        if (!v || values.includes(v)) { setDraft(''); return }
        onChange([...values, v])
        setDraft('')
    }

    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {values.map((v, i) => (
                <span
                    key={v}
                    className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded border border-black/[0.08] dark:border-white/[0.12] bg-black/[0.03] dark:bg-white/[0.05] font-mono text-[10px]"
                >
                    <span className="text-ink-muted">{i + 1}.</span>
                    {v}
                    <button
                        type="button"
                        aria-label={`Remove ${v}`}
                        onClick={() => onChange(values.filter(x => x !== v))}
                        className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-ink-muted hover:text-ink"
                    >
                        <X className="w-2.5 h-2.5" />
                    </button>
                </span>
            ))}
            <input
                value={draft}
                placeholder="source key…"
                onChange={e => setDraft(e.target.value)}
                onBlur={() => add(draft)}
                onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault()
                        add(draft)
                    }
                }}
                className="min-w-[8rem] flex-1 px-2 py-0.5 rounded bg-canvas border border-black/[0.10] dark:border-white/[0.12] font-mono text-[10px]"
            />
        </div>
    )
}
