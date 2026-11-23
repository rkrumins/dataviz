/**
 * Who to ask about a data source's data: its Owner and Stewards — people or teams —
 * on the source drawer's Overview. While nobody is named the card shows who it worked
 * out instead (whoever connected it, the people named on the request it came from, else
 * the workspace's admins), and says so. Anyone who manages the source edits the
 * Stewards; the Owner is the workspace admins' or the current Owner's to change. It is
 * there while conversations or data source details are on (asking is conversations');
 * a team of more than 50 is flagged before saving, and a save someone else beat keeps
 * the draft and shows what they saved.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Crown, Loader2, MessageCircleQuestion, Pencil, ShieldCheck, Users, X } from 'lucide-react'
import { useFeature } from '@/store/features'
import { DATA_SOURCE_METADATA_FEATURE } from '@/services/dataSourceMetadataService'
import { useAppNotifications } from '@/components/ui/notifications'
import { PersonChip } from '@/components/ui/PersonChip'
import { SubjectPicker, subjectKey } from '@/components/serviceAccounts/SubjectPicker'
import {
    VIA_LABEL, contactsKey, dataSourceContactsService, type ContactEntry, type ContactRef, type DataSourceContacts,
} from '@/services/dataSourceContactsService'

const MAX_STEWARDS = 10
/** The most people a team named here may have (the server refuses more). */
const GROUP_MAX = 50

type DraftEntry = ContactRef & { name: string; memberCount?: number | null }
interface Draft { owner: DraftEntry | null; stewards: DraftEntry[] }

const draftEntry = (c: ContactEntry): DraftEntry => ({ subjectType: c.subjectType, subjectId: c.subjectId, name: c.name, memberCount: c.memberCount })
const toDraft = (c: DataSourceContacts): Draft => ({ owner: c.owner ? draftEntry(c.owner) : null, stewards: c.stewards.map(draftEntry) })

export function DataContactsCard({ wsId, dsId, onAsk }: {
    wsId: string
    dsId: string
    /** Ask the source's contacts a question (opens the conversation drawer). */
    onAsk?: () => void
}) {
    const conversations = useFeature('conversationsEnabled')
    const on = useFeature(DATA_SOURCE_METADATA_FEATURE) || conversations
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()
    const { data, isLoading, isError } = useQuery({
        queryKey: contactsKey(wsId, dsId), queryFn: () => dataSourceContactsService.get(wsId, dsId),
        enabled: on, staleTime: 60_000,
    })
    const [draft, setDraft] = useState<Draft | null>(null)
    const [problem, setProblem] = useState<string | null>(null)
    const [stale, setStale] = useState(false)
    const save = useMutation({
        mutationFn: (d: Draft) => dataSourceContactsService.save(wsId, dsId, {
            owner: d.owner ? { subjectType: d.owner.subjectType, subjectId: d.owner.subjectId } : null,
            stewards: d.stewards.map(s => ({ subjectType: s.subjectType, subjectId: s.subjectId })),
            expectedUpdatedAt: data?.updatedAt ?? null,
        }),
        onSuccess: fresh => {
            queryClient.setQueryData(contactsKey(wsId, dsId), fresh)
            // Who is named decides who may certify the source.
            void queryClient.invalidateQueries({ queryKey: ['data-source-metadata', wsId, dsId] })
            close()
            notify('success', conversations ? 'Contacts saved — questions about this data now go to them.' : 'Contacts saved.')
        },
        onError: (e: unknown) => {
            const d = (e as { detail?: { type?: string; message?: string; current?: DataSourceContacts } }).detail
            if (d?.type === 'stale') {
                // Keep the draft; what they saved takes the cache's place, so the next save is against it.
                if (d.current) queryClient.setQueryData(contactsKey(wsId, dsId), d.current)
                else void queryClient.invalidateQueries({ queryKey: contactsKey(wsId, dsId) })
                setStale(true)
                setProblem(null)
            } else {
                setProblem(d?.message || (e instanceof Error ? e.message : 'Couldn’t save the contacts.'))
            }
        },
    })
    function close() { setDraft(null); setProblem(null); setStale(false) }
    if (!on || isError) return null

    const editing = draft !== null
    return (
        <section aria-labelledby={`ds-contacts-${dsId}`} className="rounded-2xl border border-glass-border bg-canvas-elevated p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h3 id={`ds-contacts-${dsId}`} className="flex items-center gap-2 text-sm font-bold text-ink">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
                            <ShieldCheck className="h-3.5 w-3.5" aria-hidden />
                        </span>
                        Who to ask about this data
                    </h3>
                    {data && !editing && data.provenance !== 'named' && (
                        <p className="mt-1 text-[11px] text-ink-muted">
                            {data.provenance === 'derived'
                                ? 'Nobody is named yet — these are the people we worked out from how it was connected.'
                                : 'Nobody is named yet — questions go to the workspace’s admins.'}
                        </p>
                    )}
                </div>
                {data && !editing && (
                    <div className="flex shrink-0 items-center gap-1.5">
                        {onAsk && conversations && (
                            <button type="button" onClick={onAsk}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 text-xs font-semibold text-white hover:brightness-110">
                                <MessageCircleQuestion className="h-3.5 w-3.5" aria-hidden /> Ask a question
                            </button>
                        )}
                        {data.canEdit && (
                            <button type="button" onClick={() => setDraft(toDraft(data))}
                                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-glass-border px-3 text-xs font-semibold text-ink-secondary hover:text-ink">
                                <Pencil className="h-3.5 w-3.5" aria-hidden /> {data.provenance === 'named' ? 'Edit' : 'Name them'}
                            </button>
                        )}
                    </div>
                )}
            </div>

            {isLoading || !data ? (
                <div className="mt-3 space-y-2" aria-busy="true">
                    {[0, 1].map(i => <div key={i} className="h-8 animate-pulse rounded-lg bg-black/[0.04] dark:bg-white/[0.05]" />)}
                </div>
            ) : editing ? (
                <Editor data={data} draft={draft} onChange={setDraft} problem={problem} stale={stale}
                    onUseTheirs={() => { setDraft(toDraft(data)); setStale(false) }}
                    saving={save.isPending} onCancel={close} onSave={() => save.mutate(draft)} />
            ) : (
                <ul className="mt-3 space-y-2">
                    {data.owner && <Row entry={data.owner} role="Owner" data={data} />}
                    {data.stewards.map(s => <Row key={`${s.subjectType}:${s.subjectId}`} entry={s} role="Steward" data={data} />)}
                    {!data.owner && data.stewards.length === 0 && (
                        <li className="text-sm text-ink-muted">Nobody to ask yet.</li>
                    )}
                </ul>
            )}
        </section>
    )
}

function Row({ entry, role, data }: { entry: ContactEntry; role: 'Owner' | 'Steward'; data: DataSourceContacts }) {
    const caption = data.provenance === 'named' ? role : `${VIA_LABEL[entry.via]}${role === 'Owner' ? ' · suggested owner' : ''}`
    return (
        <li className="flex items-center gap-2.5">
            {entry.subjectType === 'user' ? (
                <PersonChip id={entry.subjectId} person={data.people[entry.subjectId] ?? { name: entry.name }} size="md" caption={caption} />
            ) : (
                <GroupLine entry={entry} caption={caption} />
            )}
            {role === 'Owner' && data.provenance === 'named' && (
                <Crown className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Owner" />
            )}
        </li>
    )
}

function GroupLine({ entry, caption }: { entry: Pick<ContactEntry, 'name' | 'memberCount'>; caption: string }) {
    return (
        <span className="inline-flex min-w-0 items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-indigo-500/10 text-indigo-600 dark:text-indigo-300">
                <Users className="h-4 w-4" aria-hidden />
            </span>
            <span className="min-w-0 leading-tight">
                <span className="block truncate text-[13px] font-semibold text-ink">{entry.name}</span>
                <span className="block truncate text-[11px] text-ink-muted">
                    {caption}{entry.memberCount != null ? ` · ${entry.memberCount} ${entry.memberCount === 1 ? 'person' : 'people'}` : ''}
                </span>
            </span>
        </span>
    )
}

function Editor({ data, draft, onChange, problem, stale, onUseTheirs, saving, onCancel, onSave }: {
    data: DataSourceContacts
    draft: Draft
    onChange: (d: Draft) => void
    problem: string | null
    /** Someone saved first: `data` is what they saved, and the draft is still this person's. */
    stale: boolean
    onUseTheirs: () => void
    saving: boolean
    onCancel: () => void
    onSave: () => void
}) {
    const chosen = [draft.owner, ...draft.stewards].filter(Boolean).map(r => subjectKey({ type: r!.subjectType, id: r!.subjectId }))
    const tooBig = [draft.owner, ...draft.stewards].filter((r): r is DraftEntry => !!r && r.subjectType === 'group' && (r.memberCount ?? 0) > GROUP_MAX)
    const theirs = [data.owner && `${data.owner.name} (Owner)`, ...data.stewards.map(s => s.name)].filter(Boolean).join(', ')
    const chip = (r: DraftEntry, onRemove?: () => void) => (
        <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-indigo-500/10 py-1 pl-2 pr-1 text-xs font-medium text-indigo-700 dark:text-indigo-300">
            {r.subjectType === 'group' ? <Users className="h-3 w-3 shrink-0" aria-hidden /> : null}
            <span className="truncate">{r.name}</span>
            {onRemove && (
                <button type="button" aria-label={`Remove ${r.name}`} onClick={onRemove} className="rounded-full p-0.5 hover:bg-indigo-500/20">
                    <X className="h-3 w-3" />
                </button>
            )}
        </span>
    )
    return (
        <div className="mt-3 space-y-4">
            <div>
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                    <Crown className="h-3.5 w-3.5 text-amber-500" aria-hidden /> Owner
                </p>
                {draft.owner ? (
                    chip(draft.owner, data.canEditOwner ? () => onChange({ ...draft, owner: null }) : undefined)
                ) : data.canEditOwner ? (
                    <SubjectPicker label="Choose the owner" types={['user', 'group']} exclude={chosen}
                        onPick={p => onChange({ ...draft, owner: { subjectType: p.type, subjectId: p.id, name: p.name, memberCount: p.memberCount } })} />
                ) : (
                    <p className="text-xs text-ink-muted">No owner.</p>
                )}
                {!data.canEditOwner && (
                    <p className="mt-1 text-[11px] text-ink-muted">Only the workspace’s admins or the current Owner can change the Owner.</p>
                )}
            </div>
            <div>
                <p className="mb-1.5 text-xs font-semibold text-ink-secondary">Stewards <span className="font-normal text-ink-muted">· up to {MAX_STEWARDS}</span></p>
                {draft.stewards.length > 0 && (
                    <ul aria-label="Stewards" className="mb-2 flex flex-wrap gap-1.5">
                        {draft.stewards.map(s => (
                            <li key={`${s.subjectType}:${s.subjectId}`}>
                                {chip(s, () => onChange({ ...draft, stewards: draft.stewards.filter(x => x !== s) }))}
                            </li>
                        ))}
                    </ul>
                )}
                {draft.stewards.length < MAX_STEWARDS && (
                    <SubjectPicker label="Add a steward" types={['user', 'group']} exclude={chosen}
                        onPick={p => onChange({ ...draft, stewards: [...draft.stewards, { subjectType: p.type, subjectId: p.id, name: p.name, memberCount: p.memberCount }] })} />
                )}
                <p className="mt-1 text-[11px] text-ink-muted">Teams of up to {GROUP_MAX} people. Everyone named here is asked when someone has a question about this data.</p>
            </div>
            {tooBig.length > 0 && (
                <p role="alert" className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                    <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                        {tooBig.map(g => `${g.name} has ${g.memberCount} people`).join('; ')} — a team named here can have at most {GROUP_MAX}.
                        Choose a smaller team, or name people instead.
                    </span>
                </p>
            )}
            {stale && (
                <div role="status" className="rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-xs text-ink-secondary">
                    <p className="font-semibold text-amber-800 dark:text-amber-200">Someone changed the contacts just now — here’s the newer version.</p>
                    <p className="mt-0.5">{theirs || 'Nobody named.'}</p>
                    <p className="mt-1 text-[11px] text-ink-muted">
                        Your changes are still here: save to replace theirs, or{' '}
                        <button type="button" onClick={onUseTheirs} className="font-semibold text-amber-800 hover:underline dark:text-amber-200">use theirs</button>.
                    </p>
                </div>
            )}
            {problem && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{problem}</p>}
            <div className="flex justify-end gap-2">
                <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink">Cancel</button>
                <button type="button" disabled={saving || tooBig.length > 0} onClick={onSave}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent-lineage px-3 py-1.5 text-xs font-semibold text-white hover:brightness-110 disabled:opacity-50">
                    {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />} Save contacts
                </button>
            </div>
        </div>
    )
}
