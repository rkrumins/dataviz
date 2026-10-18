/**
 * AddGrantPicker — subject-type toggle + directory search + role, used to
 * add a person or group to a share list.
 *
 * Extracted from ShareViewDialog so draft settings can reuse it; each host
 * passes the roles it grants and which one starts selected.
 */
import { useEffect, useMemo, useState } from 'react'
import { UserCog, Users2, Search, Loader2, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    searchDirectory,
    type DirectoryGroup,
    type DirectoryUser,
} from '@/services/userDirectoryService'
import { UserAvatar } from '@/components/ui/UserAvatar'


export type SubjectType = 'user' | 'group'


export function AddGrantPicker<R extends string>({
    disabled,
    roles,
    defaultRole,
    onAdd,
}: {
    disabled: boolean
    roles: { id: R; label: string; icon: LucideIcon }[]
    defaultRole: R
    onAdd: (
        subjectType: SubjectType,
        subjectId: string,
        role: R,
        label: string,
    ) => Promise<void>
}) {
    const [subjectType, setSubjectType] = useState<SubjectType>('user')
    const [search, setSearch] = useState('')
    const [users, setUsers] = useState<DirectoryUser[] | null>(null)
    const [groups, setGroups] = useState<DirectoryGroup[] | null>(null)
    const [role, setRole] = useState<R>(defaultRole)
    const [open, setOpen] = useState(false)

    // Debounced directory search — the signed-in endpoint, so creators
    // without admin rights get a working picker.
    useEffect(() => {
        if (!open) return
        let cancelled = false
        const timer = setTimeout(async () => {
            try {
                const result = await searchDirectory(search.trim(), {
                    types: [subjectType], limit: 25,
                })
                if (cancelled) return
                if (subjectType === 'user') setUsers(result.users)
                else setGroups(result.groups)
            } catch {
                /* errors surface via notification in onAdd */
            }
        }, 200)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [open, subjectType, search])

    const candidates = useMemo(
        () => (subjectType === 'user' ? users : groups) ?? [],
        [subjectType, users, groups],
    )
    const loading = (subjectType === 'user' ? users : groups) === null

    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
            {/* Search row + toggle */}
            <div className="flex items-stretch gap-2 p-2">
                {/* Subject toggle */}
                <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
                    {(['user', 'group'] as const).map(t => (
                        <button
                            key={t}
                            onClick={() => { setSubjectType(t); setSearch('') }}
                            className={cn(
                                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors',
                                subjectType === t ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                            )}
                            title={t === 'user' ? 'Pick a user' : 'Pick a group'}
                        >
                            {t === 'user' ? <UserCog className="w-3 h-3" /> : <Users2 className="w-3 h-3" />}
                            {t === 'user' ? 'User' : 'Group'}
                        </button>
                    ))}
                </div>

                {/* Search */}
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        type="text"
                        placeholder={subjectType === 'user' ? 'Add a user…' : 'Add a group…'}
                        value={search}
                        onFocus={() => setOpen(true)}
                        onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
                        className="input pl-8 h-8 text-sm bg-glass-base/40 w-full"
                    />
                </div>

                {/* Role select */}
                <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
                    {roles.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setRole(id)}
                            className={cn(
                                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors',
                                role === id ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                            )}
                            title={`Grant ${label.toLowerCase()} access`}
                        >
                            <Icon className="w-3 h-3" />
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Results */}
            {open && (
                <div className="border-t border-glass-border max-h-56 overflow-y-auto">
                    {loading ? (
                        <div className="p-4 text-center text-ink-muted text-xs">
                            <Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" />
                            Loading {subjectType}s…
                        </div>
                    ) : candidates.length === 0 ? (
                        <div className="p-4 text-center text-ink-muted text-xs">
                            {search ? 'No matches.' : `Start typing to find ${subjectType}s.`}
                        </div>
                    ) : (
                        candidates.map(c => {
                            const isUser = subjectType === 'user'
                            const u = isUser ? (c as DirectoryUser) : null
                            const g = !isUser ? (c as DirectoryGroup) : null
                            const id = isUser ? u!.id : g!.id
                            const label = isUser ? u!.displayName : g!.name
                            const sub = isUser
                                ? u!.email
                                : `${g!.memberCount} member${g!.memberCount === 1 ? '' : 's'}`
                            return (
                                <button
                                    key={id}
                                    onClick={async () => {
                                        await onAdd(subjectType, id, role, label)
                                        setSearch('')
                                        setOpen(false)
                                    }}
                                    disabled={disabled}
                                    className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50 border-b last:border-b-0 border-glass-border"
                                >
                                    {isUser ? (
                                        <UserAvatar
                                            userId={u!.id}
                                            name={label}
                                            shape="gradient"
                                            className="w-7 h-7 text-[10px] font-bold"
                                        />
                                    ) : (
                                        <div className="w-7 h-7 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                                            <Users2 className="w-3.5 h-3.5" />
                                        </div>
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm text-ink truncate">{label}</p>
                                        <p className="text-[11px] text-ink-muted truncate">{sub}</p>
                                    </div>
                                    <span className="text-[10px] font-semibold text-ink-muted shrink-0">
                                        Add as {role}
                                    </span>
                                </button>
                            )
                        })
                    )}
                </div>
            )}
        </div>
    )
}
