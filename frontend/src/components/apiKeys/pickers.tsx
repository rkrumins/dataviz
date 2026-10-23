/**
 * Choosing what a key reaches: whole workspaces, or particular views and
 * data sources.
 *
 * Both pickers show what the keys' owner holds on each item — you, or the
 * service account — because a key never reaches past its owner: ask for
 * write on something the owner only reads and the key will only read it.
 * That is said beside the item, before the key exists, rather than
 * discovered in a 403 later.
 *
 * Borders are `border-black/[0.08] dark:border-white/[0.10]`, not
 * `border-glass-border`, which is a white hairline in light mode — no edge at
 * all on the elevated surface these sit on.
 */
import { useEffect, useState } from 'react'
import { Check, Database, Eye, Loader2, Search, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
    type ApiKeyOptions,
    type ApiKeyPermissions,
    type Level,
    type PickerItem,
} from '@/services/apiKeyService'
import { RANK } from './apiKeyFormat'
import { useKeyClient, useOwnerWords, type OwnerWords } from './keyClient'
import { LevelPill } from './parts'

const EDGE = 'border-black/[0.08] dark:border-white/[0.10]'

/** "You can only read data here, so the key will only read them." */
function shortfall(
    permissions: ApiKeyPermissions, held: { views: Level; data: Level }, owner: OwnerWords,
): string | null {
    const lines = (['views', 'data'] as const)
        .filter((k) => RANK[permissions[k]] > RANK[held[k]])
        .map((k) => (held[k] === 'read'
            ? `${owner.subject} can only read ${k} here, so the key will only read them.`
            : `${owner.subject} ${owner.has} no access to ${k} here, so the key won’t either.`))
    return lines.length > 0 ? lines.join(' ') : null
}

export function WorkspacePicker({
    workspaces, selected, permissions, onChange,
}: {
    workspaces: ApiKeyOptions['workspaces']
    selected: string[]
    permissions: ApiKeyPermissions
    onChange: (ids: string[]) => void
}) {
    const owner = useOwnerWords()
    if (workspaces.length === 0) {
        return (
            <p className="text-sm text-ink-muted text-center py-6">
                {owner.subject} {owner.is} not a member of any workspace.
            </p>
        )
    }
    return (
        <ul className="grid gap-2 sm:grid-cols-2" aria-label="Workspaces">
            {workspaces.map((w) => {
                const on = selected.includes(w.id)
                const hint = on ? shortfall(permissions, w, owner) : null
                return (
                    <li key={w.id}>
                        <button
                            type="button"
                            role="checkbox"
                            aria-checked={on}
                            onClick={() => onChange(on ? selected.filter((x) => x !== w.id) : [...selected, w.id])}
                            className={cn(
                                'w-full h-full flex items-start gap-3 p-3.5 rounded-xl border-2 text-left transition-colors duration-150',
                                on ? 'border-indigo-500 bg-indigo-500/[0.06]' : cn(EDGE, 'bg-canvas-elevated hover:border-indigo-500/40'),
                            )}
                        >
                            <span className={cn(
                                'mt-0.5 w-5 h-5 rounded-md border-2 flex items-center justify-center shrink-0 transition-colors',
                                on ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-black/[0.15] dark:border-white/[0.20]',
                            )}>
                                {on && <Check className="w-3.5 h-3.5" />}
                            </span>
                            <span className="min-w-0 flex-1">
                                <span className="block text-sm font-semibold text-ink truncate">{w.name}</span>
                                <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                                    Views <LevelPill level={w.views} />
                                    <span className="ml-1">Data</span> <LevelPill level={w.data} />
                                </span>
                                {hint && (
                                    <span className="block mt-2 text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                                        {hint}
                                    </span>
                                )}
                            </span>
                        </button>
                    </li>
                )
            })}
        </ul>
    )
}

export function ResourcePicker({
    type, label, selected, permissions, onChange,
}: {
    type: 'view' | 'data_source'
    label: string
    selected: PickerItem[]
    permissions: ApiKeyPermissions
    onChange: (items: PickerItem[]) => void
}) {
    const Icon = type === 'view' ? Eye : Database
    const client = useKeyClient()
    const owner = useOwnerWords()
    const [q, setQ] = useState('')
    const [results, setResults] = useState<{ q: string; items: PickerItem[] } | null>(null)
    useEffect(() => {
        let cancelled = false
        const handle = setTimeout(() => {
            client.searchResources(type, q)
                .then((items) => { if (!cancelled) setResults({ q, items }) })
                .catch(() => { if (!cancelled) setResults({ q, items: [] }) })
        }, 200)
        return () => { cancelled = true; clearTimeout(handle) }
    }, [type, q, client])

    const asked = type === 'view' ? permissions.views : permissions.data
    const chosen = new Set(selected.map((s) => s.id))
    const searching = results === null || results.q !== q
    const offered = (results?.items ?? []).filter((r) => !chosen.has(r.id))

    return (
        <div className={cn('rounded-2xl border-2 bg-canvas-elevated overflow-hidden', EDGE)}>
            <div className={cn('flex items-center gap-2 px-4 py-3 border-b', EDGE)}>
                <Icon className="w-4 h-4 text-indigo-500" aria-hidden />
                <span className="text-sm font-semibold text-ink">{label}</span>
                <span className="ml-auto text-[11px] font-semibold tabular-nums text-ink-muted">
                    {selected.length > 0 ? `${selected.length} selected` : 'None selected'}
                </span>
            </div>

            {selected.length > 0 && (
                <ul className={cn('px-3 py-2.5 space-y-1.5 border-b bg-indigo-500/[0.03]', EDGE)} aria-label={`Selected ${label.toLowerCase()}`}>
                    {selected.map((s) => {
                        const short = RANK[asked] > RANK[s.level]
                        return (
                            <li key={s.id} className="flex items-start gap-2">
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-medium text-ink truncate">{s.name}</span>
                                    {short ? (
                                        <span className="block text-[11px] leading-snug text-amber-600 dark:text-amber-400">
                                            {owner.subject} can only read this — the key will only read it.
                                        </span>
                                    ) : s.workspaceName && (
                                        <span className="block text-[11px] text-ink-muted truncate">{s.workspaceName}</span>
                                    )}
                                </span>
                                <button
                                    type="button"
                                    onClick={() => onChange(selected.filter((x) => x.id !== s.id))}
                                    aria-label={`Remove ${s.name}`}
                                    className="p-1 rounded-md text-ink-muted hover:text-ink hover:bg-black/[0.05] dark:hover:bg-white/[0.08]"
                                >
                                    <X className="w-3.5 h-3.5" />
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}

            <div className="p-3">
                <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                    <input
                        aria-label={`Search ${label.toLowerCase()}`}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder={`Search ${label.toLowerCase()}`}
                        className={cn(
                            'w-full h-9 pl-8 pr-8 rounded-xl border bg-canvas text-sm text-ink placeholder:text-ink-muted outline-none',
                            'focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10', EDGE,
                        )}
                    />
                    {searching && (
                        <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted animate-spin" aria-hidden />
                    )}
                </div>
                <ul className="mt-2 max-h-44 overflow-y-auto -mx-1">
                    {offered.map((r) => (
                        <li key={r.id}>
                            <button
                                type="button"
                                onClick={() => onChange([...selected, r])}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-black/[0.04] dark:hover:bg-white/[0.06]"
                            >
                                <span className="min-w-0 flex-1">
                                    <span className="block text-xs font-medium text-ink truncate">{r.name}</span>
                                    {r.workspaceName && <span className="block text-[11px] text-ink-muted truncate">{r.workspaceName}</span>}
                                </span>
                                <span className={cn(
                                    'shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded',
                                    r.level === 'write'
                                        ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                                        : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted',
                                )}>
                                    {owner.you
                                        ? (r.level === 'write' ? 'you edit' : 'you read')
                                        : (r.level === 'write' ? 'it edits' : 'it reads')}
                                </span>
                            </button>
                        </li>
                    ))}
                    {!searching && offered.length === 0 && (
                        <li className="px-2 py-3 text-center text-[11px] text-ink-muted">
                            {q.trim() ? `Nothing called “${q.trim()}” that ${owner.object} can reach.` : 'Nothing more to add.'}
                        </li>
                    )}
                </ul>
            </div>
        </div>
    )
}
