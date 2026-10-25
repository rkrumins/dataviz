/**
 * Choosing a person or a team: to manage a service account, or to take a
 * leaver's place. It searches the directory — people who can sign in, and
 * teams — which never lists a service account.
 */
import { useEffect, useId, useState } from 'react'
import { Loader2, Search, User, Users } from 'lucide-react'

import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { cn } from '@/lib/utils'
import type { ManagerRef, ManagerType } from '@/services/serviceAccountService'
import { searchDirectory } from '@/services/userDirectoryService'

/** A person or a team, with what to call them. */
export interface Subject extends ManagerRef {
    name: string
    detail: string
}

export const subjectKey = (s: ManagerRef) => `${s.type}:${s.id}`

export function SubjectPicker({ label, types = ['user', 'group'], exclude = [], onPick }: {
    label: string
    types?: ManagerType[]
    /** `subjectKey`s not to offer: already chosen, or the person leaving. */
    exclude?: string[]
    onPick: (subject: Subject) => void
}) {
    const inputId = useId()
    const [q, setQ] = useState('')
    const query = useDebouncedValue(q.trim(), 250)
    const [found, setFound] = useState<{ query: string; subjects: Subject[] } | null>(null)
    // As a string, so a list written inline is not a new search each render.
    const kinds = types.join(',')

    useEffect(() => {
        if (!query) return
        let live = true
        searchDirectory(query, { types: kinds.split(',') as ManagerType[], limit: 8 })
            .then((res) => {
                if (!live) return
                setFound({
                    query,
                    subjects: [
                        ...res.users.map((u) => ({ type: 'user' as const, id: u.id, name: u.displayName, detail: u.email })),
                        ...res.groups.map((g) => ({
                            type: 'group' as const, id: g.id, name: g.name,
                            detail: `Team · ${g.memberCount} member${g.memberCount === 1 ? '' : 's'}`,
                        })),
                    ],
                })
            })
            .catch(() => { if (live) setFound({ query, subjects: [] }) })
        return () => { live = false }
    }, [query, kinds])

    const searching = query !== '' && found?.query !== query
    const offered = found?.query === query ? found.subjects.filter((s) => !exclude.includes(subjectKey(s))) : []
    const what = types.length === 1 ? (types[0] === 'user' ? 'people' : 'teams') : 'people and teams'

    return (
        <div>
            <label htmlFor={inputId} className="block text-xs font-semibold text-ink-secondary mb-1.5">{label}</label>
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden />
                <input
                    id={inputId}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={`Search ${what}`}
                    autoComplete="off"
                    className="w-full h-9 pl-9 pr-8 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-canvas text-sm text-ink placeholder:text-ink-muted outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/10"
                />
                {searching && (
                    <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-ink-muted" aria-hidden />
                )}
            </div>
            {query !== '' && !searching && (
                <ul aria-label={`Matching ${what}`} className="mt-2 max-h-56 overflow-y-auto rounded-xl border border-black/[0.08] dark:border-white/[0.10] divide-y divide-black/[0.05] dark:divide-white/[0.06]">
                    {offered.length === 0 ? (
                        <li className="px-3 py-3 text-center text-xs text-ink-muted">Nothing called “{query}” to choose.</li>
                    ) : offered.map((s) => {
                        const Icon = s.type === 'group' ? Users : User
                        return (
                            <li key={subjectKey(s)}>
                                <button
                                    type="button"
                                    onClick={() => { onPick(s); setQ('') }}
                                    className={cn('w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-indigo-500/[0.05]')}
                                >
                                    <Icon className="w-4 h-4 text-indigo-500 shrink-0" aria-hidden />
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-sm font-medium text-ink truncate">{s.name}</span>
                                        <span className="block text-[11px] text-ink-muted truncate">{s.detail}</span>
                                    </span>
                                </button>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
