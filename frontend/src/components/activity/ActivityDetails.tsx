/**
 * What an event recorded, drawn as what changed and what it was about.
 *
 * Recorded details come in a few shapes, and each reads best its own way:
 *
 * - one setting changed (`from` / `to`, or a flag's `from` / `value`): a
 *   before → after, with the setting's own name when the record gives one;
 * - several changed at once (`changes: [{ field, from, to }]`, a job's live
 *   limits): a before → after per field;
 * - an update that records only which fields it set (`fields`): those fields;
 * - a publish that took bulk property edits to Published (`propertyJobs`):
 *   each edit, what it did, to how many entities, who ran it and why;
 * - everything else: labelled values, each drawn as its kind (`ValueView`).
 *
 * Ids the record names are named here too, from the names the server already
 * resolved for this event.
 */
import type { ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'

import { cn } from '@/lib/utils'
import { KeyValueList, ValueView, humanizeKey, type KnownNames } from '@/components/ui/ValueView'
import { propertyJobLabel } from '@/components/canvas/property-manager/op/opModel'
import type { PropertyJobOp } from '@/services/versioningApiService'

type Details = Record<string, unknown>

interface Change {
    field: string | null
    from: unknown
    to: unknown
}

const isPlainObject = (v: unknown): v is Details =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The changes a record states, and what is left of it once they are taken out. */
export function splitChanges(details: Details): { changes: Change[]; fields: string[]; rest: Details } {
    const rest: Details = { ...details }
    const changes: Change[] = []
    const fields: string[] = []

    if (Array.isArray(rest.changes) && rest.changes.every((c) => isPlainObject(c) && 'field' in c)) {
        for (const c of rest.changes as Details[]) {
            changes.push({ field: String(c.field), from: c.from, to: c.to })
        }
        delete rest.changes
    }
    if ('from' in rest && ('to' in rest || 'value' in rest)) {
        const field = typeof rest.key === 'string' ? rest.key : null
        const to = 'to' in rest ? rest.to : rest.value
        // A change of a group of settings reads as a change of each.
        if (isPlainObject(rest.from) && isPlainObject(to)) {
            const keys = Array.from(new Set([...Object.keys(rest.from), ...Object.keys(to)]))
            for (const k of keys) changes.push({ field: k, from: rest.from[k], to: to[k] })
        } else {
            changes.push({ field, from: rest.from, to })
        }
        delete rest.from
        delete rest.to
        delete rest.value
        if (field !== null) delete rest.key
    }
    if (Array.isArray(rest.fields) && rest.fields.every((f) => typeof f === 'string')) {
        fields.push(...(rest.fields as string[]))
        delete rest.fields
    }
    return { changes, fields, rest }
}

/** One bulk property edit a publish lists (`property_job.audit_entry`). */
export interface BulkEdit {
    jobId?: string
    label: string
    changed: number
    refused: number
    actor?: string
    message?: string
    /** A review merged in part landed some of what it changed. */
    partial: boolean
}

/** The bulk property edits a publish took to Published (`propertyJobs: {total, jobs}`), and the
 *  rest of the record without them. */
export function splitBulkEdits(details: Details): { edits: BulkEdit[]; total: number; rest: Details } {
    const record = details.propertyJobs
    const listed = isPlainObject(record) && Array.isArray(record.jobs) ? record.jobs.filter(isPlainObject) : null
    if (!listed || listed.length === 0) return { edits: [], total: 0, rest: details }
    const rest: Details = { ...details }
    delete rest.propertyJobs
    const edits = listed.map((j) => ({
        jobId: typeof j.jobId === 'string' ? j.jobId : undefined,
        label: typeof j.label === 'string' && j.label ? j.label
            : isPlainObject(j.op) && typeof j.op.kind === 'string' ? propertyJobLabel(j.op as unknown as PropertyJobOp) : 'Bulk property edit',
        changed: typeof j.changed === 'number' ? j.changed : 0,
        refused: typeof j.refused === 'number' ? j.refused : 0,
        actor: typeof j.actor === 'string' ? j.actor : undefined,
        message: typeof j.message === 'string' && j.message ? j.message : undefined,
        partial: j.partial === true,
    }))
    const total = isPlainObject(record) && typeof record.total === 'number' ? Math.max(record.total, edits.length) : edits.length
    return { edits, total, rest }
}

function BulkEditRow({ edit, names }: { edit: BulkEdit; names?: KnownNames }) {
    return (
        <li className="min-w-0">
            <p className="flex flex-wrap items-baseline gap-x-1.5 text-xs font-semibold text-ink">
                <span className="min-w-0 break-words">{edit.label}</span>
                {edit.partial && (
                    <span className="rounded bg-amber-500/10 px-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">in part</span>
                )}
            </p>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1 text-[11px] text-ink-muted">
                <span>
                    <span className="tabular-nums text-ink-secondary">{edit.changed.toLocaleString()}</span>{' '}
                    {edit.changed === 1 ? 'entity' : 'entities'} changed in the draft
                    {edit.refused > 0 && <> · <span className="tabular-nums">{edit.refused.toLocaleString()}</span> not changed</>}
                </span>
                {edit.actor && <span className="inline-flex items-center gap-1">· by <ValueView value={edit.actor} keyHint="actor" names={names} /></span>}
            </div>
            {edit.message && <p className="mt-0.5 text-[11px] text-ink-secondary break-words">“{edit.message}”</p>}
        </li>
    )
}

function Side({ value, field, names, tone, label }: {
    value: unknown
    field: string
    names?: KnownNames
    tone: 'before' | 'after'
    label: string
}) {
    return (
        <span
            className={cn(
                'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs ring-1 ring-inset',
                tone === 'before'
                    ? 'bg-rose-500/[0.05] ring-rose-500/15'
                    : 'bg-emerald-500/[0.06] ring-emerald-500/20',
            )}
        >
            <span className="sr-only">{label}: </span>
            {value === null || value === undefined || value === ''
                ? <span className="italic text-ink-muted">Not set</span>
                : <ValueView value={value} keyHint={field} names={names} />}
        </span>
    )
}

function ChangeRow({ change, names }: { change: Change; names?: KnownNames }) {
    const field = change.field ?? ''
    const unchanged = same(change.from, change.to)
    return (
        <li className="min-w-0">
            {change.field && (
                <p className="mb-1 flex items-baseline gap-1.5 text-[11px] text-ink-muted">
                    <span className="font-semibold text-ink-secondary">{humanizeKey(change.field)}</span>
                    {humanizeKey(change.field).toLowerCase() !== change.field.toLowerCase() && (
                        <span className="truncate font-mono text-[10px]">{change.field}</span>
                    )}
                </p>
            )}
            {unchanged ? (
                <span className="inline-flex items-center gap-2 text-xs text-ink-muted">
                    <ValueView value={change.to} keyHint={field} names={names} />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">unchanged</span>
                </span>
            ) : (
                <span className="flex flex-wrap items-center gap-1.5">
                    <Side value={change.from} field={field} names={names} tone="before" label="Before" />
                    <ArrowRight aria-hidden className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                    <Side value={change.to} field={field} names={names} tone="after" label="After" />
                </span>
            )}
        </li>
    )
}

const SUBSECTION = 'mb-2 text-[11px] font-semibold text-ink-secondary'

export function ActivityDetails({ details, names, className }: {
    details: Details
    names?: KnownNames
    className?: string
}): ReactNode {
    const bulk = splitBulkEdits(details)
    const { changes, fields, rest } = splitChanges(bulk.rest)
    const hasRest = Object.keys(rest).length > 0
    if (changes.length === 0 && fields.length === 0 && !hasRest && bulk.edits.length === 0) return null

    return (
        <div className={cn('space-y-4', className)}>
            {bulk.edits.length > 0 && (
                <div>
                    <p className={SUBSECTION}>{bulk.total === 1 ? 'Bulk property edit' : `Bulk property edits · ${bulk.total.toLocaleString()}`}</p>
                    <ul className="space-y-2.5 rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.08]">
                        {bulk.edits.map((e, i) => <BulkEditRow key={e.jobId ?? i} edit={e} names={names} />)}
                        {bulk.total > bulk.edits.length && (
                            <li className="text-[11px] text-ink-muted">and {(bulk.total - bulk.edits.length).toLocaleString()} more</li>
                        )}
                    </ul>
                </div>
            )}
            {changes.length > 0 && (
                <div>
                    <p className={SUBSECTION}>{changes.length === 1 ? 'What changed' : `What changed · ${changes.length}`}</p>
                    <ul className="space-y-3 rounded-xl border border-black/[0.06] p-3 dark:border-white/[0.08]">
                        {changes.map((c, i) => <ChangeRow key={`${c.field ?? ''}:${i}`} change={c} names={names} />)}
                    </ul>
                </div>
            )}
            {fields.length > 0 && (
                <div>
                    <p className={SUBSECTION}>Fields set</p>
                    <ul className="flex flex-wrap gap-1.5">
                        {fields.map((f) => (
                            <li
                                key={f}
                                title={f}
                                className="rounded-md bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium text-ink dark:bg-white/[0.06]"
                            >
                                {humanizeKey(f)}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
            {hasRest && <KeyValueList data={rest} names={names} />}
        </div>
    )
}
