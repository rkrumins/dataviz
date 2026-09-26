/**
 * Presentational pieces of the relationship drawer: its header row, the
 * source → target "bridge", notices and detail rows.
 */
import type React from 'react'
import { ArrowDown, ArrowUpDown, Loader2, X } from 'lucide-react'
import { useEntityColorSet } from '@/hooks/useEntityVisual'
import { cn } from '@/lib/utils'
import { DrawerTrailNav } from '../DrawerTrailNav'
import type { Endpoint } from './useEndpoints'

export function DrawerHeaderRow({ badge, badgeColor, guard, onClose, onFocusNode }: {
  badge: string
  badgeColor: string
  guard: (step: () => void) => void
  onClose: () => void
  onFocusNode?: (nodeId: string) => void | Promise<unknown>
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2 min-w-0">
        <DrawerTrailNav onFocusNode={onFocusNode} guard={guard} />
        <span
          className="px-2.5 py-1 rounded-lg text-xs font-semibold uppercase tracking-wide truncate"
          style={{ backgroundColor: `${badgeColor}1a`, color: badgeColor }}
        >
          {badge}
        </span>
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close relationship details"
        className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-muted hover:text-ink hover:bg-white/10 transition-colors duration-150"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  )
}

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
  const colors = useEntityColorSet(endpoint.type ?? '')
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
          <span
            className="inline-block mt-0.5 px-1.5 py-px rounded text-[10px] font-semibold uppercase tracking-wide"
            style={{ backgroundColor: colors.bg, color: colors.text }}
          >
            {endpoint.type}
          </span>
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

export function DetailRow({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-xs text-ink-muted min-w-[96px]">{label}</span>
      <span className={cn('text-xs text-ink text-right', mono ? 'font-mono break-all' : 'break-words')}>{children}</span>
    </div>
  )
}

export function ConfirmDiscard({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6">
      <div className="w-full max-w-xs rounded-2xl border border-glass-border bg-canvas-elevated shadow-xl p-5">
        <h4 className="text-sm font-semibold text-ink">Unsaved changes</h4>
        <p className="text-xs text-ink-muted mt-1.5">
          You have unsaved property changes on this relationship. Leave and discard them?
        </p>
        <div className="flex items-center justify-end gap-2 mt-4">
          <button type="button" onClick={onKeep} className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-white/5 transition-colors">
            Keep editing
          </button>
          <button type="button" onClick={onDiscard} className="px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:brightness-110 transition-all">
            Discard
          </button>
        </div>
      </div>
    </div>
  )
}
