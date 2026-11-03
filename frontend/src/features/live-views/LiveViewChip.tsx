/**
 * LiveViewChip — a view made from a query says so in its header, and how
 * keeping it up to date is going.
 *
 * The chip reads "Auto-updating · 1,234" (or "Snapshot · 3 Nov"), its dot the
 * colour of how things stand. It opens what the view is made of, where its
 * query is searched, what the last update changed, and — for an editor — the
 * ways to act on it: refresh now, confirm or keep out a large removal, freeze
 * or resume, and the entities kept out or always included. Renders nothing for
 * any other view.
 */
import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useQuery } from '@tanstack/react-query'
import * as LucideIcons from 'lucide-react'

import { DateTime } from '@/components/ui/DateTime'
import { useAppNotifications } from '@/components/ui/notifications'
import { describeNarrow } from '@/features/narrow/model'
import { narrowErrorText } from '@/features/narrow/useNarrowResolve'
import { cn } from '@/lib/utils'
import {
  MEMBERSHIP_QUERY_KEY,
  getMembershipStatus,
  memberOps,
  putMembership,
  refreshMembership,
} from '@/services/liveViewsApi'
import { getView, viewToViewConfig, type View } from '@/services/viewApiService'
import { useFeature } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
import type { MembershipStatus, RefreshResult } from '@/types/membership'

import { chipText, diffText, statusWords, type StatusTone } from './model'

const DOT: Record<StatusTone, string> = {
  ok: 'bg-emerald-500',
  busy: 'bg-sky-500 animate-pulse',
  attention: 'bg-amber-500',
  problem: 'bg-red-500',
  quiet: 'bg-slate-400',
}

/** The canvas reads the view from the schema store: hand it the view as it now is. */
async function showLatest(viewId: string) {
  const fresh = await getView(viewId).catch(() => null)
  if (fresh) useSchemaStore.getState().addOrUpdateView(viewToViewConfig(fresh))
}

function madeFrom(status: MembershipStatus): string {
  const spec = status.definition.sources[0]?.spec
  if (!spec) return 'its query'
  const label = spec.seeds.urns
    ? `${spec.seeds.urns.length.toLocaleString()} chosen ${spec.seeds.urns.length === 1 ? 'entity' : 'entities'}`
    : 'the matches of a search'
  return describeNarrow(spec, label)
}

export function LiveViewChip({ view, canEdit }: { view: View; canEdit: boolean }) {
  const enabled = useFeature('viewMembershipEnabled')
  const madeFromQuery = !!view.config?.membership && !view.draftBranchId
  const { data: status } = useQuery({
    queryKey: [MEMBERSHIP_QUERY_KEY, view.id],
    queryFn: () => getMembershipStatus(view.id),
    enabled: enabled && madeFromQuery,
    staleTime: 15_000,
  })
  if (!enabled || !madeFromQuery || !status) return null
  const words = statusWords(status)

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${chipText(status)} — ${words.label}`}
          className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border border-accent-lineage/25 bg-accent-lineage/[0.08] text-accent-lineage hover:bg-accent-lineage/15 transition-colors"
        >
          <span className={cn('w-1.5 h-1.5 rounded-full', DOT[words.tone])} aria-hidden />
          {status.mode === 'live'
            ? <LucideIcons.RefreshCw className="w-3 h-3" aria-hidden />
            : <LucideIcons.Snowflake className="w-3 h-3" aria-hidden />}
          <span className="tabular-nums">{chipText(status)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className="z-50 w-[400px] max-w-[calc(100vw-24px)] max-h-[min(640px,calc(100vh-96px))] overflow-y-auto custom-scrollbar rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/20"
        >
          <LiveViewPanel view={view} status={status} canEdit={canEdit} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function LiveViewPanel({ view, status, canEdit }: { view: View; status: MembershipStatus; canEdit: boolean }) {
  const { notify } = useAppNotifications()
  const [busy, setBusy] = useState<string | null>(null)
  const [held, setHeld] = useState<RefreshResult | null>(null)
  const words = statusWords(status)
  const live = status.mode === 'live'
  const searchedIn = status.readIn[0]
  const members = status.counts?.members ?? status.keys
  const heldDetail = status.status === 'held' ? status.detail : held?.detail

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key)
    try {
      await run()
    } catch (err) {
      notify('error', narrowErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  const refresh = (confirm = false) => act(confirm ? 'apply' : 'refresh', async () => {
    const out = await refreshMembership(view.id, confirm)
    setHeld(out.outcome === 'held' ? out : null)
    if (out.outcome === 'applied') {
      await showLatest(view.id)
      notify('success', `Updated · ${diffText(out.diff)}`)
    } else if (out.outcome === 'unchanged') notify('info', 'Already up to date')
    else if (out.outcome === 'busy') notify('info', 'An update is already working on this view')
    else if (out.outcome === 'deferred') notify('warning', 'The graph didn’t answer in full — the view kept its members. Try again in a moment.')
  })

  const setMode = (mode: 'live' | 'snapshot') => act(mode, async () => {
    const next = await putMembership(view.id, { ifDefinitionHash: status.definitionHash, mode })
    setHeld(null)
    if (mode === 'live') await showLatest(view.id)
    notify('success', mode === 'live' ? 'Updates resumed — it follows the data again' : 'Frozen as it is — a snapshot now', {
      label: 'Undo',
      onClick: () => {
        void putMembership(view.id, { ifDefinitionHash: next.definitionHash, mode: mode === 'live' ? 'snapshot' : 'live' })
          .then(() => showLatest(view.id))
          .catch((err) => notify('error', narrowErrorText(err)))
      },
    }, 8000)
  })

  const op = (key: string, ops: Parameters<typeof memberOps>[1], done: string) => act(key, async () => {
    const out = await memberOps(view.id, ops)
    useSchemaStore.getState().addOrUpdateView(viewToViewConfig(out.view))
    notify('success', done)
  })

  return (
    <div className="text-[12.5px]">
      {/* What it is */}
      <div className="px-4 pt-4 pb-3 border-b border-glass-border/60">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80">
            {live ? 'Auto-updating view' : 'Snapshot'}
          </span>
          <span className={cn('inline-flex items-center gap-1.5 text-[11.5px] font-semibold', {
            ok: 'text-emerald-600 dark:text-emerald-400', busy: 'text-sky-600 dark:text-sky-400',
            attention: 'text-amber-600 dark:text-amber-400', problem: 'text-red-600 dark:text-red-400', quiet: 'text-ink-muted',
          }[words.tone])}>
            <span className={cn('w-1.5 h-1.5 rounded-full', DOT[words.tone])} aria-hidden />
            {words.label}
          </span>
        </div>
        <p className="mt-2 text-[13px] text-ink leading-snug">Made from {madeFrom(status)}.</p>
        {searchedIn && (
          <p className="mt-1 text-[12px] text-ink-muted">
            Searches in{' '}
            {searchedIn.available
              ? <span className="text-ink font-medium">{searchedIn.name ?? 'a view you can’t open'}</span>
              : <span className="text-red-600 dark:text-red-400">a view that’s gone</span>}
          </p>
        )}
        <p className="mt-2 text-[12px] text-ink-muted leading-snug">{words.detail}</p>
      </div>

      {/* What it holds */}
      <div className="px-4 py-3 border-b border-glass-border/60 grid grid-cols-3 gap-2">
        <Figure value={members} label={members === 1 ? 'entity' : 'entities'} />
        <Figure value={status.counts?.containers ?? 0} label="containers" />
        <Figure value={status.keys} label={`of ${status.limit.toLocaleString()} entries`} />
      </div>
      {status.lastAppliedAt && (
        <div className="px-4 py-2.5 border-b border-glass-border/60 flex items-center justify-between gap-3 text-[12px] text-ink-muted">
          <DateTime at={status.lastAppliedAt} prefix="Updated " />
          <span className="tabular-nums">{diffText(status.lastDiff)}</span>
        </div>
      )}

      {/* A large removal waits for a person */}
      {canEdit && heldDetail && (status.status === 'held' || held) && (
        <div className="mx-4 my-3 rounded-xl border border-amber-500/35 bg-amber-500/[0.06] px-3.5 py-3">
          <p className="text-[12.5px] font-semibold text-amber-700 dark:text-amber-400">
            An update would remove {Number(heldDetail.removed ?? 0).toLocaleString()} of {Number(heldDetail.of ?? 0).toLocaleString()}.
          </p>
          <p className="mt-0.5 text-[12px] text-ink-secondary">Check the query is still what you want before the view loses them.</p>
          <div className="mt-2.5 flex items-center gap-2">
            <ActionButton tone="primary" busy={busy === 'apply'} onClick={() => { void refresh(true) }} icon="Check">Apply</ActionButton>
            <ActionButton busy={busy === 'snapshot'} onClick={() => { void setMode('snapshot') }} icon="Snowflake">Keep as is</ActionButton>
          </div>
        </div>
      )}

      {/* What an editor can do */}
      {canEdit ? (
        <div className="px-4 py-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {live && (
              <ActionButton tone="primary" busy={busy === 'refresh'} onClick={() => { void refresh() }} icon="RefreshCw">Refresh now</ActionButton>
            )}
            {live
              ? <ActionButton busy={busy === 'snapshot'} onClick={() => { void setMode('snapshot') }} icon="Snowflake">Freeze as it is</ActionButton>
              : <ActionButton tone="primary" busy={busy === 'live'} onClick={() => { void setMode('live') }} icon="RefreshCw">Resume updates</ActionButton>}
          </div>
          <MemberList
            title="Kept out"
            empty="Nothing is kept out. Right-click an entity on the canvas to keep it out."
            urns={status.excluded}
            action="Bring back"
            busy={busy}
            onAct={(urn) => { void op(`unexclude:${urn}`, { unexclude: [urn] }, 'Brought back — the query decides on it again') }}
          />
          <MemberList
            title="Always included"
            empty="Nothing is always included. Right-click a member on the canvas to keep it whatever the query finds."
            urns={status.alwaysIncluded}
            action="Stop"
            busy={busy}
            onAct={(urn) => { void op(`uninclude:${urn}`, { uninclude: [urn] }, 'It follows the query again') }}
          />
        </div>
      ) : (
        <p className="px-4 py-3 text-[12px] text-ink-muted">Only someone who can edit this view can change how it is kept.</p>
      )}
    </div>
  )
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <span className="block text-[15px] font-semibold text-ink tabular-nums leading-tight">{value.toLocaleString()}</span>
      <span className="block text-[11px] text-ink-muted leading-tight">{label}</span>
    </div>
  )
}

function ActionButton({ children, icon, onClick, busy, tone = 'quiet' }: {
  children: ReactNode
  icon: keyof typeof LucideIcons
  onClick: () => void
  busy?: boolean
  tone?: 'primary' | 'quiet'
}) {
  const Icon = (busy ? LucideIcons.Loader2 : LucideIcons[icon]) as LucideIcons.LucideIcon
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className={cn(
        'h-8 px-3 rounded-lg inline-flex items-center gap-1.5 text-[12.5px] font-semibold transition disabled:opacity-60',
        tone === 'primary'
          ? 'bg-accent-lineage text-white hover:brightness-110'
          : 'text-ink-secondary border border-glass-border hover:text-ink hover:border-accent-lineage/40',
      )}
    >
      <Icon className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />
      {children}
    </button>
  )
}

function MemberList({ title, empty, urns, action, busy, onAct }: {
  title: string
  empty: string
  urns: string[]
  action: string
  busy: string | null
  onAct: (urn: string) => void
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-1.5">
        {title} <span className="tabular-nums text-ink-muted">({urns.length.toLocaleString()})</span>
      </p>
      {urns.length === 0 ? (
        <p className="text-[12px] text-ink-muted leading-snug">{empty}</p>
      ) : (
        <ul className="max-h-36 overflow-y-auto custom-scrollbar rounded-lg border border-glass-border/70 divide-y divide-glass-border/50">
          {urns.map((urn) => (
            <li key={urn} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="truncate text-[12px] text-ink" title={urn}>{urn.split(/[:/]/).pop() || urn}</span>
              <button
                type="button"
                onClick={() => onAct(urn)}
                disabled={busy !== null}
                className="flex-none text-[11.5px] font-semibold text-accent-lineage hover:underline underline-offset-2 disabled:opacity-50"
              >
                {action}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
