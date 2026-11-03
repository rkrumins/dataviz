/**
 * SearchViewChip — a subset view says so in its header: "Subset of Sales overview".
 *
 * It opens what the view shows (its search, in words), where the matches are
 * looked for (its base, named only to someone who can open it — and whether it is
 * still there), and where its layers come from: its base, followed live, or its
 * own. An editor can give it a layout of its own, follow its base again, edit its
 * search, or ask for fresh answers. Renders nothing for any other view.
 *
 * SubsetsChip — on a base view: "Subsets · 3", listing the subset views made from
 * it, so whoever changes or deletes it knows what that reaches.
 */
import { useState, type ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import * as LucideIcons from 'lucide-react'

import { useAppNotifications } from '@/components/ui/notifications'
import { narrowErrorText } from '@/features/narrow/useNarrowResolve'
import { cn } from '@/lib/utils'
import {
  SEARCH_VIEW_QUERY_KEY,
  SUBSETS_QUERY_KEY,
  getSearchStatus,
  listSubsets,
  putSearch,
} from '@/services/searchViewsApi'
import { getView, viewToViewConfig, type View } from '@/services/viewApiService'
import { useFeature } from '@/store/features'
import { useSchemaStore } from '@/store/schema'
import type { SearchViewStatus, SubsetLayout } from '@/types/searchView'
import { isSubsetConfig } from '@/types/searchView'

import { chipLabel, describePredicate } from './model'

/** The canvas reads the view from the schema store: hand it the view as it now is. */
async function showLatest(viewId: string) {
  const fresh = await getView(viewId).catch(() => null)
  if (fresh) useSchemaStore.getState().addOrUpdateView(viewToViewConfig(fresh))
}

export interface SearchViewChipProps {
  view: View
  canEdit: boolean
  /** Opens the search, prefilled, where the subset's matches are looked for. */
  onEditSearch?: (status: SearchViewStatus) => void
  /** Asks each layer for an answer on the current data. */
  onRefresh?: () => void
}

export function SearchViewChip({ view, canEdit, onEditSearch, onRefresh }: SearchViewChipProps) {
  const enabled = useFeature('searchViewsEnabled')
  const subset = isSubsetConfig(view.config as { search?: unknown }) && !view.draftBranchId
  const { data: status } = useQuery({
    queryKey: [SEARCH_VIEW_QUERY_KEY, view.id],
    queryFn: () => getSearchStatus(view.id),
    enabled: enabled && subset,
    staleTime: 15_000,
  })
  if (!enabled || !subset || !status) return null
  const missing = status.status === 'base_missing'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={chipLabel(status)}
          className={cn(
            'inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border transition-colors max-w-[260px]',
            missing
              ? 'border-amber-500/35 bg-amber-500/[0.08] text-amber-700 dark:text-amber-400 hover:bg-amber-500/15'
              : 'border-accent-lineage/25 bg-accent-lineage/[0.08] text-accent-lineage hover:bg-accent-lineage/15',
          )}
        >
          <LucideIcons.ListFilter className="w-3 h-3 flex-none" aria-hidden />
          <span className="truncate">{chipLabel(status)}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className="z-50 w-[380px] max-w-[calc(100vw-24px)] max-h-[min(600px,calc(100vh-96px))] overflow-y-auto custom-scrollbar rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/20"
        >
          <SearchViewPanel view={view} status={status} canEdit={canEdit}
            onEditSearch={onEditSearch} onRefresh={onRefresh} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function SearchViewPanel({ view, status, canEdit, onEditSearch, onRefresh }: {
  view: View
  status: SearchViewStatus
  canEdit: boolean
  onEditSearch?: (status: SearchViewStatus) => void
  onRefresh?: () => void
}) {
  const { notify } = useAppNotifications()
  const [busy, setBusy] = useState<string | null>(null)
  const { definition, base } = status
  const inView = definition.within === 'view'
  const missing = status.status === 'base_missing'
  const follows = definition.layout === 'inherit'
  const baseName = base?.name ?? null

  const setLayout = async (layout: SubsetLayout) => {
    setBusy(layout)
    try {
      const next = await putSearch(view.id, { ifDefinitionHash: status.definitionHash, layout })
      await showLatest(view.id)
      notify('success', layout === 'own'
        ? 'It has a layout of its own now — its base’s layers, to change as you like'
        : `It follows ${baseName ?? 'its base view'}’s layers again`, {
        label: 'Undo',
        onClick: () => {
          void putSearch(view.id, { ifDefinitionHash: next.definitionHash, layout: layout === 'own' ? 'inherit' : 'own' })
            .then(() => showLatest(view.id))
            .catch((err) => notify('error', narrowErrorText(err)))
        },
      }, 8000)
    } catch (err) {
      notify('error', narrowErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="text-[12.5px]">
      <div className="px-4 pt-4 pb-3 border-b border-glass-border/60">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80">
          {inView ? 'Subset view' : 'Search view'}
        </span>
        <p className="mt-2 text-[13px] text-ink leading-snug">
          Shows the matches of <span className="font-semibold">{describePredicate(definition.predicate)}</span>
          {inView ? ' inside its base view.' : ' anywhere in the data source.'}
        </p>
        {inView && (
          <p className="mt-1.5 text-[12px] text-ink-muted">
            Subset of{' '}
            {missing
              ? <span className="text-amber-700 dark:text-amber-400">a view that’s been deleted</span>
              : baseName && base
                ? <Link to={`/views/${base.viewId}`} className="text-ink font-medium hover:underline underline-offset-2">{baseName}</Link>
                : <span className="text-ink font-medium">a view you can’t open</span>}
          </p>
        )}
        <p className="mt-2 text-[12px] text-ink-muted leading-snug">
          Always current: each layer lists what matches now. Nothing about the matches is stored.
        </p>
      </div>

      {missing ? (
        <Note tone="attention" icon="AlertTriangle">
          Its base view was deleted, so there is nothing to look in. Restore the base view and this one shows its matches again.
        </Note>
      ) : (
        <div className="px-4 py-3 border-b border-glass-border/60 space-y-1.5">
          <p className="text-[12px] text-ink">
            {follows
              ? <>Its layers are {baseName ? <span className="font-medium">{baseName}</span> : 'its base view'}’s, followed as they change.</>
              : 'It has a layout of its own.'}
          </p>
          <p className="text-[12px] text-ink-muted tabular-nums">
            {status.layers.length.toLocaleString()} {status.layers.length === 1 ? 'layer' : 'layers'}, each holding the matches of its types.
          </p>
          {status.placedByType && (
            <p className="text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
              Placed by type here: its base also places entities by rules on tags or properties, or by hand, which a subset doesn’t follow.
            </p>
          )}
        </div>
      )}

      {canEdit ? (
        <div className="px-4 py-3 flex flex-wrap items-center gap-2">
          {onEditSearch && !missing && inView && !baseName && (
            <p className="w-full text-[12px] text-ink-muted leading-snug">
              Its search is changed in its base view, which you can’t open.
            </p>
          )}
          {onEditSearch && !missing && (!inView || !!baseName) && (
            <ActionButton tone="primary" icon="Search" onClick={() => onEditSearch(status)}>Edit search…</ActionButton>
          )}
          {onRefresh && !missing && (
            <ActionButton icon="RefreshCw" onClick={onRefresh}>Refresh</ActionButton>
          )}
          {inView && !missing && (follows
            ? <ActionButton icon="Columns3" busy={busy === 'own'} onClick={() => { void setLayout('own') }}>Make its own layout</ActionButton>
            : <ActionButton icon="Link2" busy={busy === 'inherit'} onClick={() => { void setLayout('inherit') }}>
                Follow {baseName ?? 'its base'} again
              </ActionButton>)}
        </div>
      ) : (
        <p className="px-4 py-3 text-[12px] text-ink-muted">Only someone who can edit this view can change its search.</p>
      )}
    </div>
  )
}

// ── On a base view: the subsets made from it ────────────────────────────────

export function SubsetsChip({ view }: { view: View }) {
  const enabled = useFeature('searchViewsEnabled')
  const ordinary = !isSubsetConfig(view.config as { search?: unknown }) && !view.draftBranchId
  const { data } = useQuery({
    queryKey: [SUBSETS_QUERY_KEY, view.id],
    queryFn: () => listSubsets(view.id),
    enabled: enabled && ordinary,
    staleTime: 60_000,
  })
  if (!enabled || !ordinary || !data || data.count === 0) return null
  const hidden = data.count - data.items.length

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={`${data.count} subset ${data.count === 1 ? 'view' : 'views'} made from this view`}
          className="inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border border-glass-border text-ink-secondary hover:text-ink hover:border-accent-lineage/40 transition-colors"
        >
          <LucideIcons.ListFilter className="w-3 h-3" aria-hidden />
          <span className="tabular-nums">Subsets · {data.count.toLocaleString()}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          sideOffset={8}
          align="start"
          collisionPadding={12}
          className="z-50 w-[320px] max-w-[calc(100vw-24px)] rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/20 p-4 text-[12.5px]"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80">Subset views made from this view</p>
          <p className="mt-1 text-[12px] text-ink-muted leading-snug">
            They show a search’s matches here, in this view’s layers. Changing its layers changes theirs; deleting it leaves them waiting.
          </p>
          <ul className="mt-2.5 max-h-56 overflow-y-auto custom-scrollbar divide-y divide-glass-border/50 rounded-lg border border-glass-border/70">
            {data.items.map((item) => (
              <li key={item.viewId}>
                <Link to={`/views/${item.viewId}`} className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-accent-lineage/[0.06]">
                  <span className="truncate text-ink">{item.name}</span>
                  <span className="flex-none text-[11px] text-ink-muted">{item.layout === 'inherit' ? 'follows' : 'own layout'}</span>
                </Link>
              </li>
            ))}
          </ul>
          {hidden > 0 && (
            <p className="mt-2 text-[11.5px] text-ink-muted">
              And {hidden.toLocaleString()} you can’t open.
            </p>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function Note({ tone, icon, children }: { tone: 'attention'; icon: keyof typeof LucideIcons; children: ReactNode }) {
  const Icon = LucideIcons[icon] as LucideIcons.LucideIcon
  return (
    <div className={cn('mx-4 my-3 flex gap-2 rounded-xl border px-3 py-2.5 text-[12px] leading-snug',
      tone === 'attention' && 'border-amber-500/35 bg-amber-500/[0.06] text-amber-800 dark:text-amber-300')}>
      <Icon className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden />
      <span>{children}</span>
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
