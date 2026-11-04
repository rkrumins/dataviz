/**
 * SaveSearchAsViewSheet — keep a search's matches as a view of their own.
 *
 * The matches of the search just run, inside the view it was run in, become a
 * subset view: always current (it stores the search, never the matches), any
 * size, made at once, laid out like the view it came from and shared like any
 * view. Nothing is saved blind: the preview counts what each layer would hold.
 *
 * Beside the matches it can keep what they reach — everything inside them, what
 * contains them, one lineage step either way — still live and any size; and
 * fewer layers: a layer left out in the preview takes its matches with it. More
 * reach than that is a list of members, which Narrow makes.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { Backdrop } from '@/components/ui/Backdrop'
import { Kbd } from '@/components/ui/Kbd'
import { Segmented } from '@/components/ui/Segmented'
import { narrowErrorText } from '@/features/narrow/useNarrowResolve'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { createFromSearch } from '@/services/searchViewsApi'
import type { View } from '@/services/viewApiService'
import type { Predicate } from '@/types/search'
import type { SearchViewDefinition, SubsetInclude, SubsetLayer, SubsetWithin } from '@/types/searchView'
import { NO_INCLUDE, REST_LAYER_ID } from '@/types/searchView'

import {
  anyIncluded,
  combinedWith,
  describePredicate,
  includeWords,
  layerPredicate,
  layersLike,
  nameFrom,
  perTypeLayers,
  placesByMoreThanType,
  requestOf,
  REST_LAYER_NAME,
  withInclude,
  type BoardLayer,
  type LayoutChoice,
} from './model'
import { useLayerCounts } from './useLayerCounts'
import { useTypeBreakdown } from './useTypeBreakdown'

export interface SaveSearchAsViewSheetProps {
  /** The view the search was run in. */
  viewId: string
  viewName: string
  workspaceId: string
  dataSourceId?: string | null
  /** The search as it was run. */
  predicate: Predicate
  /** The board of the view it was run in (for a subset view, its base's layers). */
  boardLayers: BoardLayer[]
  /** The view's whole board config, to tell when it places by more than type. */
  boardConfig?: Record<string, unknown> | null
  /** When it was run inside a subset view: that view's search, and its base. */
  subset?: { definition: SearchViewDefinition; baseName: string | null } | null
  typeLabel?: (type: string) => string
  /** From a narrowing kept live: what it reaches, and where it looks. */
  initialInclude?: SubsetInclude
  initialWithin?: SubsetWithin
  /** Beside the title: keep it as a list of members instead (from a narrowing). */
  headerExtra?: ReactNode
  /** More reach than a live view keeps (two lineage steps, chosen entities): narrow first. */
  onNarrowInstead?: () => void
  onClose: () => void
  onSaved: (view: View) => void
}

/** What a live view can keep beside the matches, as the sheet offers it. */
const INCLUDES: Array<{ key: keyof SubsetInclude; label: string; hint: string; icon: keyof typeof LucideIcons }> = [
  { key: 'contents', label: 'Everything inside them', hint: 'However deep', icon: 'ListTree' },
  { key: 'containers', label: 'What contains them', hint: 'Up to the top', icon: 'FolderUp' },
  { key: 'upstream', label: 'What feeds them', hint: 'One step upstream', icon: 'ArrowLeftToLine' },
  { key: 'downstream', label: 'What they feed', hint: 'One step downstream', icon: 'ArrowRightToLine' },
]

const CARDS: Record<LayoutChoice, { icon: keyof typeof LucideIcons; title: (base: string) => string }> = {
  like: { icon: 'Columns3', title: (b) => `Like “${b}”` },
  perType: { icon: 'Shapes', title: () => 'A layer per type found' },
  one: { icon: 'Rows3', title: () => 'One layer' },
}

const NO_TYPES: Array<{ type: string; count: number }> = []
const NONE_LEFT_OUT: ReadonlySet<string> = new Set()

const number = new Intl.NumberFormat()
const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** The server's own words for a refused save, where it gave some. */
function saveErrorText(err: unknown): string {
  const detail = (err as { detail?: unknown } | null)?.detail
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message
  }
  if (typeof detail === 'string') return detail
  const status = httpStatusOf(err)
  if (status === 403) return 'You can’t create views in this workspace, or read its data source.'
  return narrowErrorText(err)
}

export function SaveSearchAsViewSheet({
  viewId, viewName, workspaceId, dataSourceId, predicate, boardLayers, boardConfig, subset,
  typeLabel, initialInclude, initialWithin, headerExtra, onNarrowInstead, onClose, onSaved,
}: SaveSearchAsViewSheetProps) {
  const kept = combinedWith(subset?.definition, predicate, viewId)
  const baseName = subset ? (subset.baseName ?? 'its base view') : viewName
  const sentence = describePredicate(predicate, typeLabel)

  const [name, setName] = useState(() => capitalise(nameFrom(sentence)))
  const [within, setWithin] = useState<SubsetWithin>(subset?.definition.within ?? initialWithin ?? 'view')
  const [choice, setChoice] = useState<LayoutChoice>('like')
  const [include, setInclude] = useState<SubsetInclude>(initialInclude ?? NO_INCLUDE)
  const [visibility, setVisibility] = useState<'private' | 'workspace'>('private')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One per sheet: a retry of this save answers with the view the first attempt made.
  const [idempotencyKey] = useState(() => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`))

  const offers: Array<{ choice: LayoutChoice; available: boolean; hint: string }> = [
    { choice: 'like', available: true, hint: within === 'view'
      ? 'Its layers, followed as they change — each match in the layer of its type'
      : 'A copy of its layers — each match in the layer of its type' },
    { choice: 'perType', available: true, hint: 'A column for each kind it holds, the most common first' },
    { choice: 'one', available: true, hint: 'Every match in one list' },
  ]

  // What the view finds — its search and what it includes.
  const found = useMemo(() => withInclude(kept.predicate, include), [kept.predicate, include])
  // The kinds it holds, asked for only while a layer per type is chosen.
  const breakdown = useTypeBreakdown(choice === 'perType' ? kept.baseViewId : null, found, within === 'dataSource')
  const typeCounts = breakdown.status === 'done' ? breakdown.types : NO_TYPES

  const layers: SubsetLayer[] = useMemo(() => {
    if (choice === 'like') return layersLike(boardLayers)
    if (choice === 'perType') {
      if (breakdown.status !== 'done') return []
      const { layers: typed } = perTypeLayers(typeCounts, typeLabel)
      return layersLike([...typed.map((l, i) => ({ id: `layer-${i + 1}`, name: l.name, order: i, entityTypes: l.entityTypes })),
        { id: REST_LAYER_ID, name: REST_LAYER_NAME, order: typed.length, showUnassigned: true }])
    }
    return [{ id: REST_LAYER_ID, name: 'Matches', entityTypes: [], rest: true, excludedTypes: [] }]
  }, [choice, boardLayers, breakdown.status, typeCounts, typeLabel])

  // The base's layers left out, with their matches — by a subset that follows its
  // base alone: an own layout's left-out type would land in "Other matches".
  const canHide = choice === 'like' && within === 'view' && layers.length > 1
  const [leftOut, setLeftOut] = useState<ReadonlySet<string>>(NONE_LEFT_OUT)
  const hidden = canHide ? leftOut : NONE_LEFT_OUT
  const toggleLeftOut = (id: string) => setLeftOut((was) => {
    const next = new Set(was)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  // What the view finds in each layer it keeps.
  const toCount = useMemo(() => layers.flatMap((layer) => {
    if (hidden.has(layer.id)) return []
    const p = layerPredicate(found, layer)
    return p ? [{ id: layer.id, predicate: p }] : []
  }), [layers, found, hidden])
  const keptLayers = layers.filter((l) => !hidden.has(l.id) && (l.rest || l.entityTypes.length > 0))
  const counts = useLayerCounts(kept.baseViewId, toCount, within === 'dataSource')
  const countOf = (id: string) => (counts.status === 'counting' || counts.status === 'done') ? counts.counts.get(id) : undefined
  const total = toCount.reduce((sum, l) => sum + (countOf(l.id)?.count ?? 0), 0)
  // Each layer's share, drawn against the fullest one so a small layer still shows.
  const most = Math.max(1, ...toCount.map((l) => countOf(l.id)?.count ?? 0))
  const exact = counts.status === 'done' && toCount.every((l) => countOf(l.id)?.complete)

  const placedByType = choice === 'like' && !!boardConfig && placesByMoreThanType(boardConfig)
  const canSave = !!name.trim() && !saving && keptLayers.length > 0

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const out = await createFromSearch(requestOf(
        { name, visibility, within, choice, include, hidden: [...hidden] },
        { workspaceId, dataSourceId, viewId: kept.baseViewId, predicate: kept.predicate, baseLayers: boardLayers,
          typeCounts, typeLabel },
      ), idempotencyKey)
      onSaved(out.view)
    } catch (err) {
      setError(saveErrorText(err))
      setSaving(false)
    }
  }

  const onCardKey = (e: KeyboardEvent, from: LayoutChoice) => {
    const open = offers.filter((o) => o.available).map((o) => o.choice)
    const at = open.indexOf(from)
    let to: LayoutChoice | undefined
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') to = open[(at + 1) % open.length]
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') to = open[(at - 1 + open.length) % open.length]
    if (!to) return
    e.preventDefault()
    setChoice(to)
    document.getElementById(`save-search-layout-${to}`)?.focus()
  }

  return createPortal(
    <>
      <Backdrop open={true} onClick={saving ? () => {} : onClose} zClassName="z-50" className="bg-black/40 backdrop-blur-[2px]" />
      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-search-title"
        initial={{ x: 560 }}
        animate={{ x: 0 }}
        transition={MOTION.drawerSlide}
        className="fixed right-0 top-0 z-50 h-full w-[560px] max-w-[100vw] flex flex-col bg-canvas-elevated border-l border-glass-border shadow-2xl shadow-black/25"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) { e.stopPropagation(); onClose() }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save() }
        }}
      >
        <div className="flex items-start justify-between gap-3 px-7 pt-6 pb-4 border-b border-glass-border/60">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-accent-lineage/[0.12] border border-accent-lineage/25 grid place-items-center flex-none">
              <LucideIcons.ListFilter className="w-5 h-5 text-accent-lineage" strokeWidth={2.2} />
            </div>
            <div className="min-w-0">
              <h2 id="save-search-title" className="text-xl font-display font-semibold text-ink leading-tight">Save as a view</h2>
              <p className="text-[13px] text-ink-muted mt-0.5 leading-snug">These matches as a view of their own: always current, any size, shared like any view.</p>
              {headerExtra && <div className="mt-3">{headerExtra}</div>}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
            <LucideIcons.X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-7 py-5 space-y-6">
          <Section title="Name">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={200}
              aria-label="View name"
              placeholder="Name the view"
              className="w-full h-10 px-3.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border text-[14px] text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-accent-lineage/35 focus:border-accent-lineage/50"
            />
            <p className="mt-1.5 text-[12px] text-ink-muted leading-snug">
              The matches of <span className="text-ink">{subset ? `${describePredicate(subset.definition.predicate, typeLabel)} and ${sentence}` : sentence}</span>
              {anyIncluded(include) && <>, with <span className="text-ink">{includeWords(include)}</span></>}.
            </p>
          </Section>

          <Section title="Look for them in">
            <Segmented
              label="Look for them in"
              value={within}
              onChange={setWithin}
              options={[
                { value: 'view', label: `${baseName}`, icon: LucideIcons.Columns3 },
                { value: 'dataSource', label: 'The whole data source', icon: LucideIcons.Database },
              ]}
              size="md"
            />
            <p className="mt-1.5 text-[12px] text-ink-muted leading-snug">
              {within === 'view'
                ? `A subset of “${baseName}”: only what it holds. Its readers don’t need to be able to open it.`
                : 'Anywhere in the data source, whatever any view holds.'}
            </p>
          </Section>

          <Section title="Keep with them">
            <div className="grid grid-cols-2 gap-2" role="group" aria-label="Keep with them">
              {INCLUDES.map((item) => {
                const Icon = LucideIcons[item.icon] as LucideIcons.LucideIcon
                const on = include[item.key]
                return (
                  <button
                    key={item.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setInclude((was) => ({ ...was, [item.key]: !was[item.key] }))}
                    className={cn(
                      'group flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors',
                      on
                        ? 'border-accent-lineage/60 bg-accent-lineage/[0.08] ring-1 ring-accent-lineage/25'
                        : 'border-glass-border/80 hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.03]',
                    )}
                  >
                    <span className={cn('w-7 h-7 rounded-lg grid place-items-center flex-none transition-colors',
                      on ? 'bg-accent-lineage text-white' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted group-hover:text-accent-lineage')}>
                      {on ? <LucideIcons.Check className="w-4 h-4" strokeWidth={2.6} /> : <Icon className="w-4 h-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-semibold text-ink leading-tight">{item.label}</span>
                      <span className="block text-[11px] text-ink-muted leading-snug">{item.hint}</span>
                    </span>
                  </button>
                )
              })}
            </div>
            <p className="mt-2 text-[12px] text-ink-muted leading-snug">
              Kept as part of its search, so it stays current at any size.
              {onNarrowInstead && (
                <> More reach, or chosen entities?{' '}
                  <button type="button" onClick={onNarrowInstead}
                    className="font-semibold text-accent-lineage hover:underline underline-offset-2">Narrow first</button>
                  {' '}and save from there.</>
              )}
            </p>
          </Section>

          <Section title="Layout">
            <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="Layout">
              {offers.map((offer) => {
                const card = CARDS[offer.choice]
                const Icon = LucideIcons[card.icon] as LucideIcons.LucideIcon
                const on = choice === offer.choice
                return (
                  <button
                    key={offer.choice}
                    id={`save-search-layout-${offer.choice}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    disabled={!offer.available}
                    onClick={() => setChoice(offer.choice)}
                    onKeyDown={(e) => onCardKey(e, offer.choice)}
                    className={cn(
                      'group flex flex-col items-start gap-1.5 rounded-xl border px-3.5 py-3 text-left transition-colors',
                      on
                        ? 'border-accent-lineage/60 bg-accent-lineage/[0.08] ring-1 ring-accent-lineage/30'
                        : 'border-glass-border/80 hover:border-accent-lineage/40 hover:bg-accent-lineage/[0.03]',
                      !offer.available && 'opacity-50 cursor-not-allowed hover:border-glass-border/80 hover:bg-transparent',
                    )}
                  >
                    <span className={cn('w-7 h-7 rounded-lg grid place-items-center', on ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted group-hover:text-accent-lineage')}>
                      <Icon className="w-4 h-4" />
                    </span>
                    <span className="text-[13px] font-semibold text-ink leading-tight line-clamp-2 break-words max-w-full">{card.title(baseName)}</span>
                    <span className="text-[11.5px] text-ink-muted leading-snug">{offer.hint}</span>
                  </button>
                )
              })}
            </div>
            {placedByType && (
              <p className="mt-2.5 flex gap-2 text-[12px] text-amber-700 dark:text-amber-400 leading-snug">
                <LucideIcons.Info className="w-3.5 h-3.5 flex-none mt-0.5" aria-hidden />
                “{baseName}” also places entities by rules on tags or properties, or by hand. A subset places them by type.
              </p>
            )}
          </Section>

          <Section title="Preview">
            <ul className="rounded-xl border border-glass-border/70 divide-y divide-glass-border/50" aria-label="What each layer holds">
              {choice === 'perType' && breakdown.status !== 'done' && (
                <li className="flex items-center gap-2 px-3.5 py-2.5 text-[12.5px] text-ink-muted" role="status">
                  {breakdown.status === 'error' ? (
                    <><LucideIcons.CircleAlert className="w-3.5 h-3.5 flex-none text-amber-600 dark:text-amber-400" aria-hidden />
                      Couldn’t tell what kinds it holds. Choose another layout, or try again later.</>
                  ) : (
                    <><LucideIcons.Loader2 className="w-3.5 h-3.5 flex-none animate-spin" aria-hidden />
                      Finding the kinds of entity it holds…</>
                  )}
                </li>
              )}
              {layers.map((layer) => {
                const c = countOf(layer.id)
                const left = hidden.has(layer.id)
                const counted = toCount.some((l) => l.id === layer.id)
                const empty = counted && c?.complete && c.count === 0
                // Leaving out the last layer that can hold matches would leave nothing to show.
                const lastKept = !left && keptLayers.length === 1 && keptLayers[0].id === layer.id
                return (
                  <li key={layer.id} className={cn('relative overflow-hidden flex items-center justify-between gap-3 px-3.5 py-2',
                    (empty || !counted) && !left && 'opacity-50')}>
                    {/* Its share of the matches, in its colour, behind the row. */}
                    {c && c.count > 0 && (
                      <span aria-hidden className="absolute inset-y-0 left-0 opacity-[0.10] dark:opacity-[0.16] transition-[width] duration-500 ease-out"
                        style={{ width: `${Math.max(2, (c.count / most) * 100)}%`, background: layer.color ?? '#94a3b8' }} />
                    )}
                    <span className="relative flex items-center gap-2 min-w-0">
                      {canHide ? (
                        <button type="button" role="switch" aria-checked={!left} disabled={lastKept}
                          aria-label={left ? `Keep ${layer.name}` : `Leave out ${layer.name}`}
                          title={lastKept ? 'Keep at least one layer' : left ? 'Keep this layer' : 'Leave this layer and its matches out'}
                          onClick={() => toggleLeftOut(layer.id)}
                          className={cn('w-4 h-4 rounded-[5px] border-[1.5px] grid place-items-center flex-none transition-colors disabled:cursor-not-allowed',
                            left ? 'border-ink-muted/45 bg-transparent hover:border-accent-lineage/60' : 'border-transparent text-white')}
                          style={left ? undefined : { background: layer.color ?? '#94a3b8' }}>
                          {!left && <LucideIcons.Check className="w-3 h-3" strokeWidth={3} />}
                        </button>
                      ) : (
                        <span className="w-2 h-2 rounded-full flex-none" style={{ background: layer.color ?? 'var(--color-ink-muted, #94a3b8)' }} aria-hidden />
                      )}
                      <span className={cn('truncate text-[12.5px]', left ? 'text-ink-muted line-through decoration-ink-muted/50' : 'text-ink')}>{layer.name}</span>
                      {layer.rest && <span className={cn('text-[11px] text-ink-muted', left && 'opacity-60')}>· every other type</span>}
                    </span>
                    <span className="relative flex-none text-[12px] font-medium tabular-nums text-ink-secondary">
                      {left ? <span className="text-ink-muted font-normal">left out</span>
                        : !counted ? 'nothing to hold'
                          : c === undefined ? '…'
                            : empty ? 'no matches — hidden'
                              : `${number.format(c.count)}${c.complete ? '' : '+'}`}
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 text-[12px] text-ink-muted leading-snug">
              Always current · any size · the canvas lists up to 2,000 a layer, and Search in this layer finds the rest.
            </p>
          </Section>

          <Section title="Who can see it">
            <Segmented
              label="Who can see it"
              value={visibility}
              onChange={setVisibility}
              options={[{ value: 'private', label: 'Only you', icon: LucideIcons.Lock }, { value: 'workspace', label: 'The workspace', icon: LucideIcons.Users }]}
              size="md"
            />
            <p className="mt-1.5 text-[12px] text-ink-muted leading-snug">To share it with everyone, publish it from the view once it’s saved.</p>
          </Section>
        </div>

        <div className="px-7 py-4 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] space-y-2">
          <AnimatePresence initial={false}>
            {error && (
              <motion.p
                role="alert"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={MOTION.fadeIn}
                className="rounded-lg border border-red-500/30 bg-red-500/[0.06] px-3 py-2 text-[12.5px] text-red-600 dark:text-red-400"
              >
                {error}
              </motion.p>
            )}
          </AnimatePresence>
          <div className="flex items-center justify-between gap-3">
            <p className={cn('min-w-0 truncate text-[12px] tabular-nums text-ink-muted', counts.status !== 'done' && 'opacity-70')}>
              {counts.status === 'error' ? 'Couldn’t count the matches — you can still save'
                : counts.status === 'idle' ? '' : `${number.format(total)}${exact ? '' : '+'} ${anyIncluded(include) ? 'in all' : 'matches'}`}
            </p>
            <div className="flex items-center gap-2 flex-none">
              <button type="button" onClick={onClose} disabled={saving} className="h-9 px-4 rounded-xl text-[13px] font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => { void save() }}
                disabled={!canSave}
                className={cn(
                  'h-9 px-4 rounded-xl inline-flex items-center gap-2 text-[13px] font-semibold transition',
                  canSave ? 'bg-accent-lineage text-white shadow-sm hover:brightness-110' : 'bg-black/[0.06] dark:bg-white/[0.06] text-ink-muted cursor-not-allowed',
                )}
              >
                {saving ? <LucideIcons.Loader2 className="w-4 h-4 animate-spin" /> : <LucideIcons.BookmarkPlus className="w-4 h-4" />}
                {saving ? 'Saving…' : 'Save view'}
                {canSave && <Kbd shortcut="mod+enter" tone="onAccent" />}
              </button>
            </div>
          </div>
        </div>
      </motion.aside>
    </>,
    document.body,
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted/70 mb-2">{title}</p>
      {children}
    </section>
  )
}
