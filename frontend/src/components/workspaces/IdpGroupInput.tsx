/**
 * The name of a group in the identity provider (Active Directory, Entra, Okta…), with
 * suggestions — the groups your own sign-ins carried, or, for a platform administrator,
 * every group seen — and, for a platform administrator, who would get access: the people
 * whose last sign-in carried it. Free text stays allowed: a group nobody has signed in
 * with yet is still a group.
 */
import { useId, useState } from 'react'
import { Check, KeyRound, Loader2, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useIdpGroupPreview, useIdpGroupSuggestions } from '@/hooks/useWorkspaceGroups'

export function IdpGroupInput({ value, onChange, label = 'Identity-provider group', autoFocus = false }: {
    value: string
    onChange: (value: string) => void
    label?: string
    autoFocus?: boolean
}) {
    const listId = useId()
    const [open, setOpen] = useState(false)
    const [active, setActive] = useState(-1)
    const q = useDebouncedValue(value.trim(), 250)
    const suggestions = (useIdpGroupSuggestions(q, open).data ?? []).filter(s => s.idpGroup !== value.trim())
    const showList = open && suggestions.length > 0

    const pick = (idpGroup: string) => { onChange(idpGroup); setOpen(false); setActive(-1) }

    return (
        <div>
            <div className="relative">
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-violet-500" aria-hidden />
                <input
                    aria-label={label} role="combobox" aria-expanded={showList} aria-controls={listId} aria-autocomplete="list"
                    aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
                    value={value} maxLength={200} autoFocus={autoFocus} autoComplete="off"
                    placeholder="e.g. ML-Engineers, or the group’s object ID"
                    onChange={e => { onChange(e.target.value); setOpen(true); setActive(-1) }}
                    onFocus={() => setOpen(true)}
                    onBlur={() => setOpen(false)}
                    onKeyDown={e => {
                        if (!showList) return
                        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, suggestions.length - 1)) }
                        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
                        else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(suggestions[active].idpGroup) }
                        else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) }
                    }}
                    className="w-full rounded-lg border border-black/[0.08] dark:border-white/[0.10] bg-canvas py-2 pl-8 pr-3 text-sm text-ink outline-none focus:border-indigo-500"
                />
                {showList && (
                    <ul id={listId} role="listbox" aria-label="Suggested groups"
                        className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-xl">
                        {suggestions.map((s, i) => (
                            <li key={s.idpGroup} id={`${listId}-${i}`} role="option" aria-selected={i === active}
                                onMouseDown={e => { e.preventDefault(); pick(s.idpGroup) }}
                                onMouseEnter={() => setActive(i)}
                                className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm text-ink',
                                    i === active && 'bg-violet-500/[0.08]')}>
                                <span className="truncate">{s.idpGroup}</span>
                                {s.seenCount != null && (
                                    <span className="shrink-0 text-[11px] text-ink-muted">{s.seenCount} {s.seenCount === 1 ? 'person' : 'people'}</span>
                                )}
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <WhoWouldGetAccess idpGroup={q} />
        </div>
    )
}

/** Platform administrators: who had the group at their last sign-in. Nothing for anyone
 *  else — who is in a directory group isn't theirs to see. */
function WhoWouldGetAccess({ idpGroup }: { idpGroup: string }) {
    const { data, isFetching } = useIdpGroupPreview(idpGroup || null)
    if (!idpGroup || (!data && !isFetching)) return null
    if (!data) {
        return <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-muted"><Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Checking who has it…</p>
    }
    const shown = data.people.slice(0, 6)
    return (
        <div aria-label="Who would get access" className="mt-2 rounded-lg border border-glass-border bg-black/[0.015] dark:bg-white/[0.02] px-3 py-2">
            <p className="flex items-center gap-1.5 text-[11px] font-semibold text-ink-secondary">
                {data.seenCount > 0 ? <Check className="h-3 w-3 text-emerald-500" aria-hidden /> : <Users className="h-3 w-3 text-ink-muted" aria-hidden />}
                {data.seenCount > 0
                    ? `${data.seenCount} ${data.seenCount === 1 ? 'person has' : 'people have'} it — they’d join at their next sign-in`
                    : 'Nobody has signed in with it yet'}
            </p>
            {shown.length > 0 && (
                <ul className="mt-1.5 flex flex-wrap gap-1">
                    {shown.map(p => (
                        <li key={p.id} className="rounded-full bg-indigo-500/10 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-300">{p.displayName || p.id}</li>
                    ))}
                    {data.seenCount > shown.length && <li className="px-1 py-0.5 text-[11px] text-ink-muted">and {data.seenCount - shown.length} more</li>}
                </ul>
            )}
            {data.note && <p className="mt-1 text-[10px] leading-snug text-ink-muted">{data.note}</p>}
        </div>
    )
}
