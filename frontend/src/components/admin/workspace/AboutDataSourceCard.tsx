/**
 * What this data is and whether to rely on it — the first thing on a source's Overview.
 *
 * Its description (else the catalog item's, captioned "From the catalog"), the links people
 * follow to learn more, its tags; its trust status, sensitivity and note, with who set the
 * status and when; how it got here (who connected it, when, how, and from which data
 * request); and who last edited these details. Anyone who manages the source edits the
 * description, links and tags; its named Owner and Stewards and the workspace's admins
 * change the status. Someone who saved first does not cost the other their draft: the form
 * keeps it and shows the newer version beside it. Hidden while the switch is off.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
    BookOpen, Check, CircleOff, ExternalLink, Inbox, Library, Link2, Loader2, Pencil, PencilLine, Plus,
    ShieldCheck, Tag, Trash2, UserPlus, X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useFeature } from '@/store/features'
import { useAppNotifications } from '@/components/ui/notifications'
import { DateTime } from '@/components/ui/DateTime'
import { PersonChip } from '@/components/ui/PersonChip'
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton'
import { TagInput } from '@/components/ui/TagInput'
import { ClassificationBadge, TrustStatusBadge } from '@/components/dataSource/TrustBadges'
import { CLASSIFICATION_META, TRUST_META } from '@/components/dataSource/trustMeta'
import {
    CLASSIFICATIONS, CLASSIFICATION_LABEL, DATA_SOURCE_METADATA_FEATURE, HOW_LABEL, LIMITS, TRUST_LABEL, TRUST_STATUSES,
    isWebUrl, type Classification, type DataSourceLink, type DataSourceMetadata, type TrustStatus,
} from '@/services/dataSourceMetadataService'
import { contactsKey, dataSourceContactsService } from '@/services/dataSourceContactsService'
import { isStale, refusalMessage, useDataSourceMetadata, useSaveDataSourceMetadata } from '@/hooks/useDataSourceMetadata'

type Mode = 'read' | 'details' | 'trust'

const STATUS_BY: Record<TrustStatus, string> = { certified: 'Certified', in_review: 'Marked in review', deprecated: 'Deprecated' }
const STATUS_HINT: Record<TrustStatus, string> = {
    certified: 'Checked, and fit to rely on.',
    in_review: 'Being checked — use with care.',
    deprecated: 'On its way out — build nothing new on it.',
}
const NOTE_PLACEHOLDER: Record<TrustStatus | 'none', string> = {
    certified: 'What was checked, e.g. reconciled to the ledger every month-end',
    in_review: 'What is being checked, and by when',
    deprecated: 'Use … instead',
    none: 'Anything a reader should know before relying on it',
}
const ACCENT: Record<TrustStatus, string> = {
    certified: 'from-emerald-400 to-teal-500',
    in_review: 'from-amber-400 to-orange-400',
    deprecated: 'from-rose-400 to-pink-500',
}

const LABEL = 'block text-[11px] font-bold uppercase tracking-wider text-ink-muted mb-1.5'
const INPUT = 'w-full rounded-xl border border-glass-border bg-black/[0.03] px-3.5 py-2.5 text-sm text-ink placeholder:text-ink-muted/60 transition-shadow focus:border-accent-lineage/40 focus:outline-none focus:ring-2 focus:ring-accent-lineage/30 dark:bg-white/[0.04]'
const SECTION = 'text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted'
const GHOST = 'inline-flex h-8 items-center gap-1.5 rounded-lg border border-glass-border px-3 text-xs font-semibold text-ink-secondary hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.04]'
const PRIMARY = 'inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-accent-lineage to-violet-600 px-4 py-2 text-xs font-semibold text-white shadow-md shadow-accent-lineage/20 transition-all hover:-translate-y-px hover:shadow-lg disabled:translate-y-0 disabled:opacity-50 disabled:shadow-none'

export function AboutDataSourceCard({ wsId, dsId, tagSuggestions = [], onShowRequests }: {
    wsId: string
    dsId: string
    /** Tags already in use in this workspace, most used first. */
    tagSuggestions?: string[]
    /** Opens the workspace's data requests, where the one it came from is listed. */
    onShowRequests?: () => void
}) {
    const on = useFeature(DATA_SOURCE_METADATA_FEATURE)
    const { data, isLoading, isError } = useDataSourceMetadata(wsId, dsId)
    // Who is named — the same read the contacts card makes, so one request serves both.
    const contacts = useQuery({
        queryKey: contactsKey(wsId, dsId), queryFn: () => dataSourceContactsService.get(wsId, dsId),
        enabled: on && !!data?.canEdit, staleTime: 60_000,
    })
    const [mode, setMode] = useState<Mode>('read')
    if (!on || isError) return null

    return (
        <section aria-labelledby={`ds-about-${dsId}`} className="relative rounded-2xl border border-glass-border bg-canvas-elevated">
            {data?.trustStatus && <div aria-hidden className={cn('h-1 w-full rounded-t-2xl bg-gradient-to-r', ACCENT[data.trustStatus])} />}
            <div className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <h3 id={`ds-about-${dsId}`} className="flex items-center gap-2 text-sm font-bold text-ink">
                        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-500 text-white shadow-sm shadow-indigo-500/20">
                            {mode === 'trust' ? <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> : <BookOpen className="h-3.5 w-3.5" aria-hidden />}
                        </span>
                        {mode === 'details' ? 'Edit details' : mode === 'trust' ? 'Change status' : 'About this data'}
                    </h3>
                    {data && mode === 'read' && (data.canEdit || data.canEditTrust) && (
                        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                            {data.canEditTrust && (
                                <button type="button" onClick={() => setMode('trust')} className={GHOST}>
                                    <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Change status
                                </button>
                            )}
                            {data.canEdit && (
                                <button type="button" onClick={() => setMode('details')} className={GHOST}>
                                    <Pencil className="h-3.5 w-3.5" aria-hidden /> Edit details
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {isLoading || !data ? (
                    <div className="mt-4 space-y-3" aria-busy="true" aria-label="Loading the details">
                        <Skeleton className="h-5 w-40 rounded-full" />
                        <SkeletonText lines={3} />
                        <div className="flex gap-1.5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-5 w-16 rounded-full" />)}</div>
                    </div>
                ) : mode === 'details' ? (
                    <DetailsForm wsId={wsId} dsId={dsId} meta={data} suggestions={tagSuggestions} onDone={() => setMode('read')} />
                ) : mode === 'trust' ? (
                    <TrustForm wsId={wsId} dsId={dsId} meta={data} onDone={() => setMode('read')} />
                ) : (
                    <ReadView meta={data} onEdit={data.canEdit ? () => setMode('details') : undefined} onShowRequests={onShowRequests}
                        unnamed={!!data.canEdit && !!contacts.data && contacts.data.provenance !== 'named'} />
                )}
            </div>
        </section>
    )
}

// ── Reading ────────────────────────────────────────────────────────────

function ReadView({ meta, onEdit, onShowRequests, unnamed }: {
    meta: DataSourceMetadata
    onEdit?: () => void
    onShowRequests?: () => void
    /** Nobody is named as Owner or Steward, and this reader could name them. */
    unnamed: boolean
}) {
    const description = meta.description || meta.catalogDescription
    const { onboarding: o } = meta
    return (
        <div className="mt-4 space-y-4">
            {(meta.trustStatus || meta.classification) && <TrustSummary meta={meta} />}

            <div>
                {description ? (
                    <>
                        <p className="whitespace-pre-line break-words text-sm leading-relaxed text-ink">{description}</p>
                        {!meta.description && (
                            <p className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                                <Library className="h-3 w-3" aria-hidden /> From the catalog
                            </p>
                        )}
                    </>
                ) : (
                    <p className="text-sm text-ink-muted">
                        No description yet.{' '}
                        {onEdit && <button type="button" onClick={onEdit} className="font-semibold text-accent-lineage hover:underline">Add one</button>}
                    </p>
                )}
            </div>

            {meta.links.length > 0 && (
                <ul aria-label="Links" className="flex flex-wrap gap-2">
                    {meta.links.map((l, i) => <li key={`${l.url}-${i}`} className="max-w-full"><LinkPill link={l} /></li>)}
                </ul>
            )}

            {meta.tags.length > 0 && (
                <ul aria-label="Tags" className="flex flex-wrap items-center gap-1.5">
                    <Tag className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
                    {meta.tags.map(t => (
                        <li key={t} className="inline-flex max-w-full rounded-full border border-accent-lineage/20 bg-accent-lineage/10 px-2 py-0.5 text-xs font-medium text-accent-lineage"><span className="truncate">{t}</span></li>
                    ))}
                </ul>
            )}

            {(o.at || o.how || o.fromRequest) && (
                <div className="rounded-xl border border-black/[0.06] bg-gradient-to-br from-black/[0.015] to-transparent px-3.5 py-3 dark:border-white/[0.08] dark:from-white/[0.03]">
                    <p className={SECTION}>How it got here</p>
                    <ul className="mt-2 space-y-1.5 text-xs text-ink-secondary">
                        {o.at && (
                            <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                <Plus className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
                                <span>Connected</span>
                                <DateTime at={o.at} className="font-semibold text-ink" />
                                {o.by && <><span>by</span><PersonChip id={o.by.id} person={o.by} size="xs" /></>}
                                {o.how && <span className="text-ink-muted">· {HOW_LABEL[o.how]}</span>}
                            </li>
                        )}
                        {!o.at && o.how && (
                            <li className="flex items-center gap-1.5"><Plus className="h-3.5 w-3.5 text-emerald-500" aria-hidden />{HOW_LABEL[o.how]}</li>
                        )}
                        {o.fromRequest && (
                            <li className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                                <Inbox className="h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
                                <span>From the data request</span>
                                {onShowRequests ? (
                                    <button type="button" onClick={onShowRequests} className="font-semibold text-accent-lineage hover:underline">
                                        ‘{o.fromRequest.title}’
                                    </button>
                                ) : <span className="font-semibold text-ink">‘{o.fromRequest.title}’</span>}
                                {o.fromRequest.requesterName && <span className="text-ink-muted">· asked by {o.fromRequest.requesterName}</span>}
                            </li>
                        )}
                    </ul>
                </div>
            )}

            {unnamed && (
                <p className="flex items-start gap-2 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.05] px-3 py-2 text-xs text-ink-secondary">
                    <UserPlus className="mt-px h-3.5 w-3.5 shrink-0 text-indigo-500" aria-hidden />
                    Name an Owner or Stewards so they can certify it.
                </p>
            )}

            {meta.updatedAt && (
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-ink-muted">
                    <PencilLine className="h-3 w-3" aria-hidden /> <span>Details last edited</span>
                    {meta.updatedBy && <><span>by</span> <PersonChip id={meta.updatedBy.id} person={meta.updatedBy} size="xs" /></>}
                    <span aria-hidden>·</span> <DateTime at={meta.updatedAt} />
                </p>
            )}
        </div>
    )
}

function TrustSummary({ meta }: { meta: DataSourceMetadata }) {
    const deprecated = meta.trustStatus === 'deprecated'
    return (
        <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
                {meta.trustStatus && <TrustStatusBadge status={meta.trustStatus} size="md" />}
                {meta.classification && <ClassificationBadge classification={meta.classification} size="md" />}
                {meta.trustStatus && meta.trustStatusAt && (
                    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[11px] text-ink-muted">
                        <span>{STATUS_BY[meta.trustStatus]}</span>
                        {meta.trustStatusBy && <><span>by</span> <PersonChip id={meta.trustStatusBy.id} person={meta.trustStatusBy} size="xs" /></>}
                        <span aria-hidden>·</span> <DateTime at={meta.trustStatusAt} />
                    </span>
                )}
            </div>
            {meta.trustNote && (
                <p className={cn('flex items-start gap-2 rounded-xl border px-3 py-2 text-sm',
                    deprecated
                        ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-800 dark:text-rose-200'
                        : 'border-black/[0.06] bg-black/[0.02] text-ink-secondary dark:border-white/[0.08] dark:bg-white/[0.03]')}>
                    {deprecated && <CircleOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                    <span className="whitespace-pre-line break-words">{meta.trustNote}</span>
                </p>
            )}
        </div>
    )
}

function LinkPill({ link }: { link: DataSourceLink }) {
    if (!isWebUrl(link.url)) {
        // Not a web address: named, never followed.
        return <span className="inline-flex max-w-full items-center gap-1.5 rounded-xl border border-glass-border px-2.5 py-1.5 text-xs text-ink-muted"><span className="truncate">{link.label}</span></span>
    }
    return (
        <a href={link.url} target="_blank" rel="noopener noreferrer"
            className="group inline-flex max-w-full items-center gap-1.5 rounded-xl border border-glass-border bg-black/[0.02] px-2.5 py-1.5 text-xs font-semibold text-ink transition-colors hover:border-accent-lineage/30 hover:bg-accent-lineage/[0.05] dark:bg-white/[0.03]">
            <Link2 className="h-3.5 w-3.5 shrink-0 text-accent-lineage" aria-hidden />
            <span className="truncate">{link.label}</span>
            <span className="hidden truncate font-normal text-ink-muted sm:inline">{new URL(link.url).host}</span>
            <ExternalLink className="h-3 w-3 shrink-0 text-ink-muted opacity-60 group-hover:opacity-100" aria-hidden />
        </a>
    )
}

// ── Someone saved first ────────────────────────────────────────────────

function StaleNotice({ onUseTheirs, children }: { onUseTheirs: () => void; children: React.ReactNode }) {
    return (
        <div role="status" className="space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
            <p className="text-xs font-semibold text-amber-800 dark:text-amber-200">Someone changed this — here’s the newer version.</p>
            <div className="rounded-lg bg-canvas-elevated/70 px-3 py-2 text-xs text-ink-secondary">{children}</div>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-ink-muted">Your changes are still here: save to replace theirs, or start again from theirs.</p>
                <button type="button" onClick={onUseTheirs} className="text-xs font-semibold text-amber-800 hover:underline dark:text-amber-200">Use theirs</button>
            </div>
        </div>
    )
}

function FormFooter({ saving, disabled, label, onCancel, onSave }: {
    saving: boolean; disabled?: boolean; label: string; onCancel: () => void; onSave: () => void
}) {
    return (
        <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={onCancel} disabled={saving} className="rounded-xl px-3.5 py-2 text-xs font-semibold text-ink-secondary hover:text-ink">Cancel</button>
            <button type="button" onClick={onSave} disabled={saving || disabled} className={PRIMARY}>
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Check className="h-3.5 w-3.5" aria-hidden />} {label}
            </button>
        </div>
    )
}

// ── Description, links and tags ────────────────────────────────────────

interface LinkRow { key: number; label: string; url: string }
let nextKey = 0
const rowsOf = (links: DataSourceLink[]): LinkRow[] => links.map(l => ({ key: nextKey++, ...l }))

/** Why a link row can't be saved yet, or null. An empty row is simply left out. */
function linkProblem(r: LinkRow): string | null {
    const label = r.label.trim(), url = r.url.trim()
    if (!label && !url) return null
    if (!url) return 'Add the address this link opens.'
    if (!isWebUrl(url)) return 'A link starts with https:// or http://.'
    if (!label) return 'Give the link a name.'
    return null
}

function DetailsForm({ wsId, dsId, meta, suggestions, onDone }: {
    wsId: string; dsId: string; meta: DataSourceMetadata; suggestions: string[]; onDone: () => void
}) {
    const { notify } = useAppNotifications()
    const { saveDetails } = useSaveDataSourceMetadata(wsId, dsId)
    const [description, setDescription] = useState(meta.description ?? '')
    const [links, setLinks] = useState<LinkRow[]>(() => rowsOf(meta.links))
    const [tags, setTags] = useState(meta.tags)
    const [stale, setStale] = useState(false)
    const [problem, setProblem] = useState<string | null>(null)
    const blocked = links.some(r => linkProblem(r) !== null)
    const setRow = (key: number, patch: Partial<LinkRow>) => setLinks(rs => rs.map(r => (r.key === key ? { ...r, ...patch } : r)))
    const takeTheirs = () => {
        setDescription(meta.description ?? ''); setLinks(rowsOf(meta.links)); setTags(meta.tags); setStale(false)
    }
    const save = () => saveDetails.mutate({
        description: description.trim() || null,
        links: links.filter(r => r.label.trim() || r.url.trim()).map(r => ({ label: r.label.trim(), url: r.url.trim() })),
        tags,
    }, {
        onSuccess: () => { notify('success', 'Details saved.'); onDone() },
        onError: e => {
            if (isStale(e)) { setStale(true); setProblem(null) }
            else setProblem(refusalMessage(e, 'Couldn’t save the details.'))
        },
    })

    return (
        <div className="mt-4 space-y-5">
            {stale && (
                <StaleNotice onUseTheirs={takeTheirs}>
                    <p className="line-clamp-3 whitespace-pre-line">{meta.description || <span className="text-ink-muted">No description.</span>}</p>
                    {(meta.tags.length > 0 || meta.links.length > 0) && (
                        <p className="mt-1 text-ink-muted">
                            {meta.tags.length > 0 && `Tags: ${meta.tags.join(', ')}`}
                            {meta.tags.length > 0 && meta.links.length > 0 && ' · '}
                            {meta.links.length > 0 && `${meta.links.length} link${meta.links.length === 1 ? '' : 's'}`}
                        </p>
                    )}
                </StaleNotice>
            )}
            <div>
                <label htmlFor={`ds-desc-${dsId}`} className={LABEL}>Description</label>
                <textarea id={`ds-desc-${dsId}`} value={description} onChange={e => setDescription(e.target.value)}
                    rows={4} maxLength={LIMITS.description} className={cn(INPUT, 'resize-y')}
                    placeholder={meta.catalogDescription || 'What this data is, where it comes from, and what it is good for'} />
                <p className="mt-1 text-[10px] text-ink-muted">
                    {meta.catalogDescription && !description.trim() ? 'Left empty, readers see the catalog’s description. ' : ''}
                    {description.length > LIMITS.description - 500 && `${LIMITS.description - description.length} characters left.`}
                </p>
            </div>

            <fieldset>
                <legend className={LABEL}>Links <span className="font-normal normal-case tracking-normal">· up to {LIMITS.links}</span></legend>
                <ul className="space-y-2">
                    {links.map((r, i) => {
                        const p = linkProblem(r)
                        return (
                            <li key={r.key}>
                                <div className="flex flex-col gap-1.5 sm:flex-row">
                                    <input aria-label={`Link ${i + 1} name`} value={r.label} maxLength={LIMITS.linkLabel}
                                        onChange={e => setRow(r.key, { label: e.target.value })} placeholder="e.g. Runbook"
                                        className={cn(INPUT, 'py-2 sm:w-48')} />
                                    <div className="flex flex-1 gap-1.5">
                                        <input aria-label={`Link ${i + 1} address`} value={r.url} maxLength={LIMITS.url} type="url" inputMode="url"
                                            onChange={e => setRow(r.key, { url: e.target.value })} placeholder="https://…"
                                            aria-invalid={!!p} className={cn(INPUT, 'py-2 font-mono text-xs', p && 'border-rose-500/50')} />
                                        <button type="button" onClick={() => setLinks(rs => rs.filter(x => x.key !== r.key))} aria-label={`Remove link ${i + 1}`}
                                            className="shrink-0 rounded-xl px-2.5 text-ink-muted hover:bg-rose-500/10 hover:text-rose-600">
                                            <Trash2 className="h-3.5 w-3.5" aria-hidden />
                                        </button>
                                    </div>
                                </div>
                                {p && <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{p}</p>}
                            </li>
                        )
                    })}
                </ul>
                {links.length < LIMITS.links && (
                    <button type="button" onClick={() => setLinks(rs => [...rs, { key: nextKey++, label: '', url: '' }])}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-xl border border-dashed border-accent-lineage/40 px-3 py-1.5 text-xs font-semibold text-accent-lineage hover:bg-accent-lineage/[0.05]">
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Add a link
                    </button>
                )}
            </fieldset>

            <div>
                <label htmlFor={`ds-tags-${dsId}`} className={LABEL}>Tags</label>
                <TagInput id={`ds-tags-${dsId}`} value={tags} onChange={setTags} suggestions={suggestions} max={LIMITS.tags} maxLength={LIMITS.tag} />
            </div>

            {problem && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{problem}</p>}
            <FormFooter saving={saveDetails.isPending} disabled={blocked} label="Save details" onCancel={onDone} onSave={save} />
        </div>
    )
}

// ── Status, sensitivity and note ───────────────────────────────────────

function TrustForm({ wsId, dsId, meta, onDone }: { wsId: string; dsId: string; meta: DataSourceMetadata; onDone: () => void }) {
    const { notify } = useAppNotifications()
    const { saveTrust } = useSaveDataSourceMetadata(wsId, dsId)
    const [status, setStatus] = useState<TrustStatus | null>(meta.trustStatus)
    const [classification, setClassification] = useState<Classification | null>(meta.classification)
    const [note, setNote] = useState(meta.trustNote ?? '')
    const [stale, setStale] = useState(false)
    const [problem, setProblem] = useState<string | null>(null)
    const takeTheirs = () => {
        setStatus(meta.trustStatus); setClassification(meta.classification); setNote(meta.trustNote ?? ''); setStale(false)
    }
    const save = () => saveTrust.mutate({ trustStatus: status, classification, trustNote: note.trim() || null }, {
        onSuccess: () => { notify('success', 'Status saved.'); onDone() },
        onError: e => {
            if (isStale(e)) { setStale(true); setProblem(null) }
            else setProblem(refusalMessage(e, 'Couldn’t save the status.'))
        },
    })

    return (
        <div className="mt-4 space-y-5">
            {stale && (
                <StaleNotice onUseTheirs={takeTheirs}>
                    <span className="flex flex-wrap items-center gap-1.5">
                        {meta.trustStatus ? <TrustStatusBadge status={meta.trustStatus} tip={false} /> : <span>No status</span>}
                        {meta.classification && <ClassificationBadge classification={meta.classification} tip={false} />}
                    </span>
                    {meta.trustNote && <p className="mt-1 line-clamp-2">{meta.trustNote}</p>}
                </StaleNotice>
            )}
            <div>
                <span id={`ds-status-${dsId}`} className={LABEL}>Status</span>
                <div role="radiogroup" aria-labelledby={`ds-status-${dsId}`} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <Choice on={status === null} onPick={() => setStatus(null)} title="No status" detail="Neither vouched for nor on its way out." />
                    {TRUST_STATUSES.map(s => {
                        const Icon = TRUST_META[s].icon
                        return (
                            <Choice key={s} on={status === s} onPick={() => setStatus(s)} title={TRUST_LABEL[s]} detail={STATUS_HINT[s]}
                                icon={<Icon className={cn('h-4 w-4', s === 'certified' ? 'text-emerald-500' : s === 'in_review' ? 'text-amber-500' : 'text-rose-500')} />} />
                        )
                    })}
                </div>
            </div>

            <div>
                <span id={`ds-class-${dsId}`} className={LABEL}>Sensitivity</span>
                <div role="radiogroup" aria-labelledby={`ds-class-${dsId}`} className="flex flex-wrap gap-1.5">
                    {[null, ...CLASSIFICATIONS].map(c => {
                        const Icon = c ? CLASSIFICATION_META[c].icon : null
                        const chosen = classification === c
                        return (
                            <button key={c ?? 'none'} type="button" role="radio" aria-checked={chosen} onClick={() => setClassification(c)}
                                className={cn('inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                                    chosen ? 'border-accent-lineage/50 bg-accent-lineage/10 text-accent-lineage'
                                        : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30')}>
                                {Icon && <Icon className={cn('h-3.5 w-3.5', c && CLASSIFICATION_META[c].glyph)} aria-hidden />}
                                {c ? CLASSIFICATION_LABEL[c] : 'Not set'}
                            </button>
                        )
                    })}
                </div>
                <p className="mt-1.5 text-[11px] text-ink-muted">
                    {classification ? `${CLASSIFICATION_META[classification].tip}.` : 'How carefully its data has to be shared.'}
                    {classification === 'restricted' && ' Not the same as restricted publishing, which an admin sets.'}
                </p>
            </div>

            <div>
                <label htmlFor={`ds-note-${dsId}`} className={LABEL}>Note</label>
                <textarea id={`ds-note-${dsId}`} value={note} onChange={e => setNote(e.target.value)} rows={3} maxLength={LIMITS.note}
                    placeholder={NOTE_PLACEHOLDER[status ?? 'none']} className={cn(INPUT, 'resize-none')} />
                <p className="mt-1 text-[10px] text-ink-muted">Shown beside the status, to everyone who can open this source.</p>
            </div>

            <p className="text-[11px] text-ink-muted">Only its Owner, its Stewards and the workspace’s admins can change this.</p>
            {problem && <p role="alert" className="text-xs text-rose-600 dark:text-rose-400">{problem}</p>}
            <FormFooter saving={saveTrust.isPending} label="Save status" onCancel={onDone} onSave={save} />
        </div>
    )
}

function Choice({ on, onPick, title, detail, icon }: { on: boolean; onPick: () => void; title: string; detail: string; icon?: React.ReactNode }) {
    return (
        <button type="button" role="radio" aria-checked={on} onClick={onPick}
            className={cn('flex items-start gap-2.5 rounded-xl border-2 px-3 py-2.5 text-left transition-colors',
                on ? 'border-accent-lineage/60 bg-accent-lineage/[0.06]' : 'border-black/[0.06] hover:border-accent-lineage/30 dark:border-white/[0.08]')}>
            <span className="mt-0.5 shrink-0">{icon ?? <X className="h-4 w-4 text-ink-muted" aria-hidden />}</span>
            <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{title}</span>
                <span className="block text-[11px] text-ink-muted">{detail}</span>
            </span>
        </button>
    )
}
