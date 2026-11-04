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
import { LevelPicker } from '@/features/narrow/NarrowComposer'
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
import type { Depth } from '@/types/membership'
import type { SearchViewStatus, SearchViewUpdate, SubsetLayout } from '@/types/searchView'
import { isSubsetConfig, NO_INCLUDE } from '@/types/searchView'

import { anyIncluded, chipLabel, describePredicate, includeWords, keptInclude, type IncludeChoice } from './model'

/** The layers the chip names before it says how many more. */
const LAYER_PILLS = 6

/** What a subset can keep beside its matches, as the chip offers it to an editor. */
const INCLUDE_PILLS: Array<{ key: IncludeChoice; label: string }> = [
  { key: 'contents', label: 'Everything inside' },
  { key: 'containers', label: 'What contains them' },
  { key: 'upstream', label: 'What feeds them' },
  { key: 'downstream', label: 'What they feed' },
]

/** How far what is inside them, and what contains them, reach: a few levels, or the whole way. */
const LEVEL_ROWS: Array<{ on: IncludeChoice; key: 'contentsLevels' | 'containersLevels'; label: string;
  names?: { 1: string; all: string } }> = [
  { on: 'contents', key: 'contentsLevels', label: 'Levels inside them' },
  { on: 'containers', key: 'containersLevels', label: 'Levels up', names: { 1: 'Parent', all: 'Top' } },
]
const LEVELS = [1, 2, 3]

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

  const include = definition.include ?? NO_INCLUDE
  const hidden = definition.hiddenLayers ?? []
  // A change to what it keeps or shows: saved against the hash it was read at, with Undo.
  const change = async (key: string, update: Omit<SearchViewUpdate, 'ifDefinitionHash'>,
    undo: Omit<SearchViewUpdate, 'ifDefinitionHash'>, done: string) => {
    setBusy(key)
    try {
      const next = await putSearch(view.id, { ifDefinitionHash: status.definitionHash, ...update })
      await showLatest(view.id)
      notify('success', done, {
        label: 'Undo',
        onClick: () => {
          void putSearch(view.id, { ifDefinitionHash: next.definitionHash, ...undo })
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
  const toggleInclude = (key: IncludeChoice) => {
    const next = keptInclude({ ...include, [key]: !include[key] })
    void change(`include:${key}`, { include: next }, { include },
      anyIncluded(next) ? `It keeps ${includeWords(next)} now` : 'It keeps just the matches now')
  }
  const setLevels = (key: 'contentsLevels' | 'containersLevels', levels: Depth) => {
    if ((include[key] ?? 'all') === levels) return
    const next = keptInclude({ ...include, [key]: levels === 'all' ? undefined : levels })
    void change(`levels:${key}`, { include: next }, { include }, `It keeps ${includeWords(next)} now`)
  }
  const shownHolding = status.layers.filter((l) => !l.hidden && (l.rest || l.entityTypes.length > 0))
  // Fewer layers: an editor of a subset that follows its base leaves some out.
  const editLayers = canEdit && follows && !missing
  const toggleLayer = (id: string, name: string) => {
    const leaving = !hidden.includes(id)
    const next = leaving ? [...hidden, id] : hidden.filter((h) => h !== id)
    void change(`layer:${id}`, { hiddenLayers: next }, { hiddenLayers: hidden },
      leaving ? `${name} is left out, with its matches` : `${name} is shown again`)
  }

  const setLayout = async (layout: SubsetLayout) => {
    setBusy(layout)
    try {
      const next = await putSearch(view.id, { ifDefinitionHash: status.definitionHash, layout })
      await showLatest(view.id)
      // An own layout leaves nothing out: every base layer comes with it, the left-out ones too.
      const back = layout === 'own' ? hidden.length : 0
      // An own layout is layers of types: its matches are placed by type from now on.
      notify('success', layout === 'own'
        ? back
          ? `It has a layout of its own now — every one of its base’s layers, its matches placed by type, so the ${back === 1 ? 'one' : back} it left out ${back === 1 ? 'is' : 'are'} back`
          : 'It has a layout of its own now — its base’s layers, its matches placed by type, to change as you like'
        : `It follows ${baseName ?? 'its base view'}’s layers again, its matches where it places them`, {
        label: 'Undo',
        onClick: () => {
          void putSearch(view.id, layout === 'own'
            ? { ifDefinitionHash: next.definitionHash, layout: 'inherit', ...(back ? { hiddenLayers: hidden } : {}) }
            : { ifDefinitionHash: next.definitionHash, layout: 'own' })
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
          {anyIncluded(include) && <>, with <span className="font-semibold">{includeWords(include)}</span>,</>}
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

      {canEdit && !missing && (
        <div className="px-4 py-3 border-b border-glass-border/60">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/80">Keeps with them</p>
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Keeps with them">
            {INCLUDE_PILLS.map((item) => {
              const on = include[item.key]
              return (
                <button key={item.key} type="button" aria-pressed={on} disabled={busy !== null}
                  onClick={() => toggleInclude(item.key)}
                  className={cn('inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-[11.5px] font-medium transition-colors disabled:opacity-60',
                    on ? 'border-accent-lineage/50 bg-accent-lineage/[0.10] text-accent-lineage'
                      : 'border-black/[0.08] dark:border-white/[0.10] text-ink-secondary hover:border-accent-lineage/40 hover:text-ink')}>
                  {busy === `include:${item.key}`
                    ? <LucideIcons.Loader2 className="w-3 h-3 animate-spin" />
                    : on ? <LucideIcons.Check className="w-3 h-3" strokeWidth={2.6} /> : <LucideIcons.Plus className="w-3 h-3" />}
                  {item.label}
                </button>
              )
            })}
          </div>
          {LEVEL_ROWS.filter((row) => include[row.on]).map((row) => (
            <div key={row.key} className="mt-2.5 flex items-center justify-between gap-3">
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-secondary">
                {busy === `levels:${row.key}` && <LucideIcons.Loader2 className="w-3 h-3 animate-spin" aria-hidden />}
                {row.label}
              </span>
              <LevelPicker label={row.label} value={include[row.key] ?? 'all'} levels={LEVELS} names={row.names}
                disabled={busy !== null} onChange={(levels) => setLevels(row.key, levels)} />
            </div>
          ))}
        </div>
      )}

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
          {/* Its layers, as the canvas draws them: each holds the matches of its types. */}
          <ul className="flex flex-wrap gap-1.5 pt-0.5" aria-label="Its layers">
            {(editLayers ? status.layers : status.layers.filter((l) => !l.hidden)).slice(0, editLayers ? undefined : LAYER_PILLS).map((layer) => {
              const what = layer.rest ? 'Every match of a type no other layer holds' : (layer.entityTypes ?? []).join(', ')
              const pill = 'inline-flex items-center gap-1.5 max-w-[180px] h-6 px-2 rounded-full border text-[11.5px] transition-colors'
              if (!editLayers) {
                return (
                  <li key={layer.id} title={what}
                    className={cn(pill, 'border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] text-ink-secondary')}>
                    <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: layer.color ?? '#94a3b8' }} aria-hidden />
                    <span className="truncate">{layer.name}</span>
                  </li>
                )
              }
              const lastShown = !layer.hidden && shownHolding.length === 1 && shownHolding[0].id === layer.id
              return (
                <li key={layer.id}>
                  <button type="button" role="switch" aria-checked={!layer.hidden} disabled={busy !== null || lastShown}
                    onClick={() => toggleLayer(layer.id, layer.name)}
                    title={lastShown ? 'Keep at least one layer' : `${layer.hidden ? 'Show' : 'Leave out'} ${layer.name} — ${what}`}
                    className={cn(pill, 'disabled:cursor-not-allowed',
                      layer.hidden
                        ? 'border-dashed border-black/[0.12] dark:border-white/[0.14] text-ink-muted hover:text-ink'
                        : 'border-black/[0.06] dark:border-white/[0.08] bg-black/[0.02] dark:bg-white/[0.03] text-ink-secondary hover:border-accent-lineage/40')}>
                    {busy === `layer:${layer.id}`
                      ? <LucideIcons.Loader2 className="w-3 h-3 animate-spin flex-none" />
                      : layer.hidden
                        ? <LucideIcons.EyeOff className="w-3 h-3 flex-none" aria-hidden />
                        : <span className="w-1.5 h-1.5 rounded-full flex-none" style={{ background: layer.color ?? '#94a3b8' }} aria-hidden />}
                    <span className={cn('truncate', layer.hidden && 'line-through decoration-ink-muted/40')}>{layer.name}</span>
                  </button>
                </li>
              )
            })}
            {!editLayers && status.layers.filter((l) => !l.hidden).length > LAYER_PILLS && (
              <li className="inline-flex items-center h-6 px-2 text-[11.5px] text-ink-muted tabular-nums">
                +{(status.layers.filter((l) => !l.hidden).length - LAYER_PILLS).toLocaleString()} more
              </li>
            )}
          </ul>
          {editLayers && (
            <p className="text-[11.5px] text-ink-muted leading-snug">Choose a layer to leave it out, with its matches. It keeps following {baseName ?? 'its base'}.</p>
          )}
          {status.placedByType && (
            <p className="text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
              {status.placedByTypeReason ?? 'Its base places entities in more ways than a subset can follow, so it places its matches by type.'}
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
          : 'text-ink-secondary border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.03] hover:text-ink hover:border-accent-lineage/40',
      )}
    >
      <Icon className={cn('w-3.5 h-3.5', busy && 'animate-spin')} />
      {children}
    </button>
  )
}
