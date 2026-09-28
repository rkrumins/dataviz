/**
 * Presentational pieces of the relationship drawer: the source → target
 * "bridge", notices, the details list and relationship type chips.
 */
import type React from 'react'
import { ArrowDown, ArrowUpDown, Loader2 } from 'lucide-react'
import { useEdgeVisual } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import { EntityTypeTag } from '../shell/EntityRef'
import type { Endpoint } from './useEndpoints'

/**
 * Source → relationship → target, read top to bottom. Each end opens that
 * entity in the drawer, on the same trail — the way back is one click.
 */
export function Bridge({ source, target, label, color, bidirectional, onOpen, pendingId, unreachableId }: {
  source: Endpoint
  target: Endpoint
  label: string
  color: string
  bidirectional?: boolean
  onOpen: (id: string) => void
  pendingId?: string | null
  unreachableId?: string | null
}) {
  const Arrow = bidirectional ? ArrowUpDown : ArrowDown
  return (
    <div className="flex flex-col" data-testid="relationship-bridge">
      <EndpointCard role={bidirectional ? 'Between' : 'From'} endpoint={source} onOpen={onOpen}
        pending={pendingId === source.id} unreachable={unreachableId === source.id} />
      <div className="flex items-center gap-2 pl-6 py-1">
        <span className="w-px h-5" style={{ backgroundColor: color }} />
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border"
          style={{ color, backgroundColor: `${color}14`, borderColor: `${color}40` }}
        >
          <Arrow className="w-3.5 h-3.5" />
          {label}
        </span>
      </div>
      <EndpointCard role={bidirectional ? 'And' : 'To'} endpoint={target} onOpen={onOpen}
        pending={pendingId === target.id} unreachable={unreachableId === target.id} />
    </div>
  )
}

function EndpointCard({ role, endpoint, onOpen, pending, unreachable }: {
  role: string
  endpoint: Endpoint
  onOpen: (id: string) => void
  pending: boolean
  unreachable: boolean
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(endpoint.id)}
      title={endpoint.id}
      aria-label={`Open ${endpoint.name}`}
      className="group flex items-center gap-3 w-full p-2.5 rounded-xl border border-glass-border text-left bg-black/[0.03] dark:bg-white/[0.04] hover:bg-black/5 dark:hover:bg-white/10 transition-colors duration-150"
    >
      <span className="w-10 text-[10px] font-semibold uppercase tracking-wide text-ink-muted flex-shrink-0">{role}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-ink truncate">{endpoint.name}</span>
        {unreachable ? (
          <span className="block text-[11px] text-amber-600 dark:text-amber-400">Not on this view</span>
        ) : endpoint.type ? (
          <EntityTypeTag typeId={endpoint.type} className="mt-0.5" />
        ) : null}
      </span>
      {pending && <Loader2 className="w-4 h-4 animate-spin text-ink-muted flex-shrink-0" />}
    </button>
  )
}

export function Notice({ tone, children, action }: {
  tone: 'info' | 'warn' | 'ok' | 'danger'
  children: React.ReactNode
  action?: { label: string; onClick: () => void }
}) {
  const cls = {
    info: 'bg-sky-500/10 border-sky-500/20 text-sky-700 dark:text-sky-300',
    warn: 'bg-amber-500/10 border-amber-500/20 text-amber-700 dark:text-amber-300',
    ok: 'bg-green-500/10 border-green-500/20 text-green-700 dark:text-green-400',
    danger: 'bg-rose-500/10 border-rose-500/30 text-rose-700 dark:text-rose-300',
  }[tone]
  return (
    <div className={cn('px-3 py-2 rounded-lg border text-xs flex items-center gap-2', cls)} role="status">
      <span className="flex-1">{children}</span>
      {action && (
        <button type="button" onClick={action.onClick} className="font-semibold underline underline-offset-2 whitespace-nowrap">
          {action.label}
        </button>
      )}
    </div>
  )
}

/** Label → value rows in one quiet card. */
export function DetailList({ children }: { children: React.ReactNode }) {
  return (
    <dl className="rounded-xl border border-black/[0.06] dark:border-glass-border divide-y divide-black/[0.06] dark:divide-glass-border bg-black/[0.015] dark:bg-white/[0.02]">
      {children}
    </dl>
  )
}

export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <dt className="w-24 flex-shrink-0 pt-0.5 text-xs text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 text-xs text-ink break-words">{children}</dd>
    </div>
  )
}

/** A relationship type, in its own colour. */
export function TypeChip({ type, label }: { type: string; label: string }) {
  const color = useEdgeVisual(type).strokeColor
  return (
    <span
      className="px-2 py-0.5 rounded-full text-[11px] font-semibold border"
      style={{ color, backgroundColor: `${color}14`, borderColor: `${color}40` }}
      title={type}
    >
      {label}
    </span>
  )
}
