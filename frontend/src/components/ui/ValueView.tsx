/**
 * ValueView — a recorded value, drawn as what it is.
 *
 * Detail panels used to print every value through `String()`, so a boolean
 * read "true", a timestamp read as an ISO string, a person as `usr_7f3a…`
 * and a nested setting as a line of raw JSON. Here each kind of value gets the
 * component a person would reach for:
 *
 * - yes/no as a pill; numbers grouped, durations and sizes in their units;
 * - an ISO instant as a `DateTime` (readable, exact on hover);
 * - a person's id as a `PersonChip`; any other id as a chip that shows its
 *   name where the record named it, and copies;
 * - a short code-like value (`manual`, `external_wins`) as a badge;
 * - lists as chips, nested objects as an indented list — never JSON.
 *
 * Detection is by shape first and by key second, and conservative: a value it
 * cannot place is shown as text, verbatim.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowUpRight, Check, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { formatSpan } from '@/lib/smartTime'

import { Badge, type BadgeTone } from './Badge'
import { CopyButton } from './CopyButton'
import { DateTime } from './DateTime'
import { PersonChip } from './PersonChip'

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const PERSON_ID = /^usr_[A-Za-z0-9_-]{2,}$/
/** A minted id: a short prefix and a hex tail (`agg_3f9c0a1b2c3d`). */
const ENTITY_ID = /^[a-z]{1,8}_[0-9a-f]{8,}$/
const UUID = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
/** A key that says its value is an id (`jobId`, `batch_id`). */
const ID_KEY = /(Id|_id)$/
const WEB_URL = /^https?:\/\/\S+$/i
/** A short code-like token: `manual`, `external_wins`, `ws-admin`. */
const CODE_TOKEN = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/
const SECONDS_KEY = /(seconds|secs)$/i
/** `scan_timeout_s`, `writeTimeoutS` — the short form, case kept. */
const SHORT_SECONDS_KEY = /(_s|[a-z]S)$/
const MS_KEY = /(Ms|_ms|millis)$/
const BYTES_KEY = /bytes$/i
const SHARE_KEY = /(share|fraction)$/i
/** A unit the value already shows, so the label need not say it. */
const UNIT_SUFFIX = /(_secs?|_seconds|_s|_ms|_millis|Secs?|Seconds|Ms|Millis)$/
const CAMEL_SECONDS = /([a-z])S$/

/** The words a status is written in, and the tone each reads in. */
const STATUS_TONE: Record<string, BadgeTone> = {
    completed: 'success', succeeded: 'success', success: 'success', approved: 'success', active: 'success',
    failed: 'danger', failure: 'danger', denied: 'danger', rejected: 'danger', error: 'danger',
    cancelled: 'warning', canceled: 'warning', skipped: 'warning', expired: 'warning',
    running: 'info', queued: 'info', pending: 'neutral',
}

/** Names the record already knows for the ids in it, so a chip can say what it points at. */
export type KnownNames = Record<string, string>

/** `triggerSource` → "Trigger source"; `jobId` → "Job"; `timeout_secs` → "Timeout". */
export function humanizeKey(key: string): string {
    const words = key
        .replace(/Id$/, '')
        .replace(/_id$/, '')
        .replace(UNIT_SUFFIX, '')
        .replace(CAMEL_SECONDS, '$1')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/_/g, ' ')
        .trim()
        .toLowerCase() || key
    return words.charAt(0).toUpperCase() + words.slice(1)
}

function formatBytes(n: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let v = n
    let i = 0
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024
        i += 1
    }
    return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

const MUTED = 'text-ink-muted'

/** An id, named where the record named it, and copyable. */
export function IdChip({ id, name }: { id: string; name?: string | null }) {
    return (
        <span className="inline-flex max-w-full items-center gap-1 rounded-md border border-black/[0.06] bg-black/[0.02] py-px pl-1.5 pr-0.5 align-middle dark:border-white/[0.08] dark:bg-white/[0.03]">
            {name && <span className="truncate text-[11px] font-medium text-ink">{name}</span>}
            <span className={cn('truncate font-mono text-[10px]', name ? 'text-ink-muted' : 'text-ink-secondary')}>{id}</span>
            <CopyButton value={id} label={`Copy ${id}`} className="p-0.5" iconClassName="h-2.5 w-2.5" />
        </span>
    )
}

function LongText({ text }: { text: string }) {
    const [open, setOpen] = useState(false)
    if (text.length <= 160) return <span className="break-words text-ink">{text}</span>
    return (
        <span className="text-ink">
            <span className="break-words">{open ? text : `${text.slice(0, 140)}…`}</span>{' '}
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setOpen((v) => !v) }}
                className="text-[11px] font-semibold text-accent-lineage hover:underline"
            >
                {open ? 'Show less' : 'Show all'}
            </button>
        </span>
    )
}

/** One value, by kind. `keyHint` is its key, for units; `names` names its ids. */
export function ValueView({ value, keyHint = '', names, depth = 0 }: {
    value: unknown
    keyHint?: string
    names?: KnownNames
    depth?: number
}): ReactNode {
    if (value === null || value === undefined || value === '') {
        return <span className={MUTED}>—</span>
    }
    if (typeof value === 'boolean') {
        return value ? (
            <Badge tone="success" className="align-middle"><Check aria-hidden className="h-3 w-3" />Yes</Badge>
        ) : (
            <Badge tone="neutral" className="align-middle"><Minus aria-hidden className="h-3 w-3" />No</Badge>
        )
    }
    if (typeof value === 'number') {
        let text: string
        if (SECONDS_KEY.test(keyHint) || SHORT_SECONDS_KEY.test(keyHint)) text = formatSpan(value * 1000)
        else if (MS_KEY.test(keyHint)) text = formatSpan(value)
        else if (BYTES_KEY.test(keyHint)) text = formatBytes(value)
        else if (SHARE_KEY.test(keyHint) && value >= 0 && value <= 1) text = `${(value * 100).toFixed(value < 0.1 ? 1 : 0)}%`
        else text = value.toLocaleString()
        return <span className="font-semibold tabular-nums text-ink">{text}</span>
    }
    if (typeof value === 'string') {
        const v = value.trim()
        if (ISO_INSTANT.test(v)) return <DateTime at={v} className="font-medium text-ink" />
        if (PERSON_ID.test(v)) return <PersonChip id={v} size="xs" />
        if (ENTITY_ID.test(v) || UUID.test(v) || (ID_KEY.test(keyHint) && v.length <= 128 && !/\s/.test(v))) {
            return <IdChip id={v} name={names?.[v]} />
        }
        if (WEB_URL.test(v)) {
            return (
                <a
                    href={v}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex max-w-full items-center gap-0.5 break-all text-accent-lineage hover:underline"
                >
                    {v}
                    <ArrowUpRight aria-hidden className="h-3 w-3 shrink-0" />
                </a>
            )
        }
        if (v.length <= 40 && CODE_TOKEN.test(v)) {
            const tone = STATUS_TONE[v]
            return tone
                ? <Badge tone={tone} className="align-middle">{v}</Badge>
                : <Badge tone="neutral" className="align-middle font-mono">{v}</Badge>
        }
        return <LongText text={v} />
    }
    if (Array.isArray(value)) {
        if (value.length === 0) return <span className={MUTED}>None</span>
        const flat = value.every((v) => v === null || typeof v !== 'object')
        if (flat) {
            const shown = value.slice(0, 12)
            return (
                <span className="flex flex-wrap items-center gap-1">
                    {shown.map((v, i) => (
                        <span key={i} className="max-w-full">
                            <ValueView value={v} keyHint={keyHint} names={names} depth={depth + 1} />
                        </span>
                    ))}
                    {value.length > shown.length && (
                        <span className="text-[11px] font-semibold text-ink-muted">+{value.length - shown.length} more</span>
                    )}
                </span>
            )
        }
        return (
            <ol className="space-y-1.5">
                {value.slice(0, 20).map((v, i) => (
                    <li key={i} className="flex gap-2">
                        <span className="mt-0.5 w-4 shrink-0 text-right text-[10px] font-semibold tabular-nums text-ink-muted">{i + 1}</span>
                        <div className="min-w-0 flex-1">
                            <ValueView value={v} keyHint={keyHint} names={names} depth={depth + 1} />
                        </div>
                    </li>
                ))}
                {value.length > 20 && <li className="pl-6 text-[11px] text-ink-muted">+{value.length - 20} more</li>}
            </ol>
        )
    }
    if (typeof value === 'object') {
        if (depth > 3) return <span className="font-mono text-[11px] text-ink-secondary">{JSON.stringify(value)}</span>
        return <KeyValueList data={value as Record<string, unknown>} names={names} depth={depth + 1} nested />
    }
    return <span className="text-ink">{String(value)}</span>
}

/** An object as label → value rows: two columns at the top, stacked when nested. */
export function KeyValueList({ data, names, depth = 0, nested = false, className }: {
    data: Record<string, unknown>
    names?: KnownNames
    depth?: number
    nested?: boolean
    className?: string
}) {
    const entries = Object.entries(data)
    if (entries.length === 0) return <span className={MUTED}>Empty</span>
    return (
        <dl className={cn(
            nested
                ? 'space-y-1 border-l-2 border-black/[0.06] pl-2.5 dark:border-white/[0.08]'
                : 'grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2',
            className,
        )}>
            {entries.map(([key, value]) => (
                <div key={key} className={cn('min-w-0', nested && 'flex flex-wrap items-baseline gap-x-2')}>
                    <dt className={cn(
                        'text-ink-muted',
                        nested ? 'shrink-0 text-[11px]' : 'text-[10px] font-semibold uppercase tracking-[0.12em]',
                    )}>
                        {humanizeKey(key)}
                    </dt>
                    <dd className={cn('min-w-0 text-xs', !nested && 'mt-1')}>
                        <ValueView value={value} keyHint={key} names={names} depth={depth} />
                    </dd>
                </div>
            ))}
        </dl>
    )
}
