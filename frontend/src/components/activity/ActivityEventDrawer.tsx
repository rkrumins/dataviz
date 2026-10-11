/**
 * One event, in full: who, when, where, why — and what else happened with it.
 *
 * "With it" is two lists the timeline cannot show: everything the SAME
 * request did (a member added to a group revokes their sessions in the same
 * breath), and the latest other events on the SAME target (the rebuild before
 * this one, and who started it). Each is one click from becoming the event in
 * the drawer.
 *
 * The raw payload is the record as emitted, kept one disclosure down for when
 * the summary is not enough. A workspace admin's scope never receives it.
 */
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { ArrowUpRight, ChevronRight, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { formatUtc, timeAgo } from '@/lib/timeAgo'
import { useModalA11y } from '@/hooks/useModalA11y'
import { useActivityEvent } from '@/hooks/useActivity'
import { Backdrop } from '@/components/ui/Backdrop'
import { SkeletonText } from '@/components/ui/Skeleton'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import type { ActivityEvent, ActivityScope } from '@/services/activityService'

import { ActivityPerson, IdField } from './ActivityPerson'
import { CATEGORY_META, actorName, reasonExpected } from './activityMeta'
import { activityLinks, personHref } from './activityLinks'

const SECTION = 'text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted'

/** A detail value as a reader would write it. */
function detailText(value: unknown): string {
    if (value === null || value === undefined) return '—'
    if (typeof value === 'boolean') return value ? 'Yes' : 'No'
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    return JSON.stringify(value)
}

/** `triggerSource` → "Trigger source". */
function detailLabel(key: string): string {
    const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase()
    return words.charAt(0).toUpperCase() + words.slice(1)
}

function RelatedList({ title, events, onOpen }: {
    title: string
    events: ActivityEvent[]
    onOpen: (id: string) => void
}) {
    if (events.length === 0) return null
    return (
        <section>
            <h3 className={SECTION}>{title}</h3>
            <ul className="mt-1.5 space-y-0.5">
                {events.map((e) => (
                    <li key={e.id}>
                        <button
                            type="button"
                            onClick={() => onOpen(e.id)}
                            className="flex w-full items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            <span className="min-w-0 truncate text-xs text-ink">
                                {actorName(e) && <span className="font-semibold">{actorName(e)} · </span>}
                                {e.summary || e.label}
                            </span>
                            <time
                                dateTime={e.occurredAt}
                                title={formatUtc(e.occurredAt)}
                                className="shrink-0 text-[10px] text-ink-muted"
                            >
                                {timeAgo(e.occurredAt)}
                            </time>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    )
}

export function ActivityEventDrawer({ scope, eventId, onClose, onOpen }: {
    scope: ActivityScope
    eventId: string | null
    onClose: () => void
    /** Switch the drawer to another event. */
    onOpen: (id: string) => void
}) {
    const theme = useChartTheme()
    const detail = useActivityEvent(scope, eventId)
    const open = !!eventId
    const dialogRef = useModalA11y(open, onClose)
    const event = detail.data?.event
    const meta = event ? CATEGORY_META[event.category] ?? CATEGORY_META.platform : null
    const color = meta ? theme.series[meta.slot] : undefined
    const details = Object.entries(event?.details ?? {})
        .filter(([key]) => key !== 'filters')
    const links = event ? activityLinks(event) : []

    return createPortal(
        <>
            <Backdrop open={open} onClick={onClose} />
            {/* No AnimatePresence: unmount instantly on close so an interrupted
                exit cannot strand an invisible click-blocker over the page. */}
            {open && (
                <motion.div
                    ref={dialogRef}
                    tabIndex={-1}
                    role="dialog"
                    aria-modal="true"
                    aria-label="Activity event"
                    initial={{ x: '100%' }}
                    animate={{ x: 0 }}
                    transition={MOTION.drawerSlide}
                    className="fixed right-0 top-0 z-50 h-full w-full max-w-xl overflow-y-auto bg-canvas border-l border-glass-border shadow-2xl outline-none"
                >
                    <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-glass-border bg-canvas p-4">
                        <div className="min-w-0">
                            {meta && (
                                <p className="text-[11px] font-semibold" style={{ color }}>
                                    {meta.label} · {event?.label}
                                </p>
                            )}
                            <h2 className="text-base font-bold text-ink">
                                {event ? (event.summary || event.label) : 'Loading…'}
                            </h2>
                        </div>
                        <button
                            type="button"
                            onClick={onClose}
                            aria-label="Close"
                            className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="space-y-6 p-4">
                        {detail.isLoading && <SkeletonText lines={6} />}
                        {detail.error && !event && (
                            <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">
                                This event could not be loaded: {(detail.error as Error).message}
                            </p>
                        )}

                        {event && (
                            <>
                                <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                    <div>
                                        <dt className={SECTION}>Who</dt>
                                        <dd className="mt-1.5">
                                            {event.actor
                                                ? <ActivityPerson person={event.actor} size="md" />
                                                : <span className="text-sm text-ink-secondary">{actorName(event) ?? '—'}</span>}
                                        </dd>
                                    </div>
                                    {event.subject && event.subject.id !== event.actor?.id && (
                                        <div>
                                            <dt className={SECTION}>Who it happened to</dt>
                                            <dd className="mt-1.5"><ActivityPerson person={event.subject} size="md" /></dd>
                                        </div>
                                    )}
                                    <div>
                                        <dt className={SECTION}>When</dt>
                                        <dd className="mt-1.5 text-sm text-ink">
                                            <time dateTime={event.occurredAt}>{formatUtc(event.occurredAt)}</time>
                                            <span className="block text-[11px] text-ink-muted">{timeAgo(event.occurredAt)}</span>
                                        </dd>
                                    </div>
                                    {(event.workspaceId || event.dataSourceId) && (
                                        <div>
                                            <dt className={SECTION}>Where</dt>
                                            <dd className="mt-1.5 text-sm text-ink">
                                                {event.workspaceId && (
                                                    <a
                                                        href={`/workspaces/${encodeURIComponent(event.workspaceId)}`}
                                                        className={cn('block truncate hover:text-accent-lineage hover:underline',
                                                            !event.workspaceName && 'font-mono text-[12px]')}
                                                    >
                                                        {event.workspaceName || event.workspaceId}
                                                    </a>
                                                )}
                                                {event.dataSourceId && (
                                                    <span className={cn('block truncate text-[11px] text-ink-muted',
                                                        !event.dataSourceName && 'font-mono')}>
                                                        {event.dataSourceName || event.dataSourceId}
                                                    </span>
                                                )}
                                            </dd>
                                        </div>
                                    )}
                                </dl>

                                <section>
                                    <h3 className={SECTION}>Why</h3>
                                    {event.statedReason ? (
                                        <blockquote className="mt-1.5 border-l-2 border-indigo-500/40 pl-3 text-sm italic text-ink">
                                            “{event.statedReason}”
                                        </blockquote>
                                    ) : (
                                        <p className="mt-1.5 text-sm text-ink-muted">
                                            {reasonExpected(event)
                                                ? 'No reason given.'
                                                : 'Not something a reason is asked for.'}
                                        </p>
                                    )}
                                </section>

                                {details.length > 0 && (
                                    <section>
                                        <h3 className={SECTION}>Details</h3>
                                        <dl className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-1.5 sm:grid-cols-2">
                                            {details.map(([key, value]) => (
                                                <div key={key} className="min-w-0">
                                                    <dt className="text-[11px] text-ink-muted">{detailLabel(key)}</dt>
                                                    <dd className="break-words text-xs text-ink">{detailText(value)}</dd>
                                                </div>
                                            ))}
                                        </dl>
                                    </section>
                                )}

                                {links.length > 0 && (
                                    <section>
                                        <h3 className={SECTION}>Go to</h3>
                                        <ul className="mt-1.5 flex flex-wrap gap-2">
                                            {links.map((link) => (
                                                <li key={link.key}>
                                                    <a
                                                        href={link.href}
                                                        className="inline-flex items-center gap-1 rounded-lg border border-glass-border px-2.5 py-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/5"
                                                    >
                                                        {link.label}
                                                        <ArrowUpRight className="h-3 w-3" aria-hidden />
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                <section>
                                    <h3 className={SECTION}>Identifiers</h3>
                                    <dl className="mt-1.5 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
                                        <IdField label="Event id" value={event.id} />
                                        <IdField label="Event type" value={event.eventType} />
                                        <IdField
                                            label="Actor id"
                                            value={event.actor?.id}
                                            href={event.actor?.id && event.actorKind === 'user' ? personHref(event.actor.id) : undefined}
                                        />
                                        <IdField
                                            label="Subject id"
                                            value={event.subject?.id}
                                            href={event.subject?.id ? personHref(event.subject.id) : undefined}
                                        />
                                        <IdField label="Target id" value={event.target?.id} />
                                        <IdField label="Workspace id" value={event.workspaceId} />
                                        <IdField label="Data source id" value={event.dataSourceId} />
                                        <IdField label="Request id" value={event.correlationId} />
                                    </dl>
                                </section>

                                {/* Everything else the event references, named —
                                    the key for the raw payload below. An id the
                                    server could not name is simply not listed. */}
                                {Object.keys(event.resolvedNames ?? {}).length > 0 && (
                                    <section>
                                        <h3 className={SECTION}>Named in this event</h3>
                                        <ul className="mt-1.5 flex flex-wrap gap-2">
                                            {Object.entries(event.resolvedNames).map(([id, name]) => (
                                                <li
                                                    key={id}
                                                    className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-2 py-1"
                                                >
                                                    <span className="text-[11px] font-medium text-ink">{name}</span>
                                                    <span className="font-mono text-[10px] text-ink-muted">{id}</span>
                                                </li>
                                            ))}
                                        </ul>
                                    </section>
                                )}

                                <RelatedList
                                    title="In the same request"
                                    events={detail.data?.sameRequest ?? []}
                                    onOpen={onOpen}
                                />
                                <RelatedList
                                    title={`Also on ${event.target?.label || 'this target'}`}
                                    events={detail.data?.sameTarget ?? []}
                                    onOpen={onOpen}
                                />

                                {event.payload && (
                                    <details className="group/raw rounded-xl border border-black/[0.07] bg-black/[0.02] dark:border-white/[0.08] dark:bg-white/[0.02]">
                                        <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2 text-[11px] font-semibold text-ink-secondary hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                            <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform group-open/raw:rotate-90" />
                                            Raw event payload
                                        </summary>
                                        <pre className="overflow-x-auto whitespace-pre-wrap break-words px-3 pb-3 font-mono text-2xs text-ink-secondary">
                                            {JSON.stringify(event.payload, null, 2)}
                                        </pre>
                                    </details>
                                )}
                            </>
                        )}
                    </div>
                </motion.div>
            )}
        </>,
        document.body,
    )
}
