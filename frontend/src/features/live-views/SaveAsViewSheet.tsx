/**
 * SaveAsViewSheet — keep a narrowing as a view of its own.
 *
 * The canvas narrowed to some entities and what they reach becomes a whole view
 * on the same data: its own layers, sharing and history. It keeps itself up to
 * date by default (what newly matches arrives, what stops matching leaves) or
 * stays as it is (a snapshot). Nothing is saved blind: the preview works out
 * the layers it would start with and what each holds, counts the entries
 * against the limit a view can hold, and says in words what would help when a
 * result is over it.
 */
import { useMemo, useState, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import * as LucideIcons from 'lucide-react'

import { fitTemplate } from '@/components/templates/templateFit'
import { Backdrop } from '@/components/ui/Backdrop'
import { Kbd } from '@/components/ui/Kbd'
import { Segmented } from '@/components/ui/Segmented'
import { describeNarrow, truncationNotes } from '@/features/narrow/model'
import type { NarrowDraft } from '@/features/narrow/narrowStore'
import { narrowErrorText } from '@/features/narrow/useNarrowResolve'
import { useLayoutTemplates, useLayoutTemplatesEnabled } from '@/hooks/useLayoutTemplates'
import { MOTION } from '@/lib/motion'
import { cn } from '@/lib/utils'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { createFromMembers } from '@/services/liveViewsApi'
import type { View } from '@/services/viewApiService'
import { useSchemaEntityTypes } from '@/store/schema'
import type { MembershipPlan } from '@/types/membership'

import {
  createRequestOf,
  layoutOffers,
  meterText,
  overLimitHelp,
  planRequestOf,
  seedCapNote,
  type LayoutChoice,
  type SaveChoices,
} from './model'
import { usePlanPreview } from './usePlanPreview'

export interface SaveAsViewSheetProps {
  /** The view the narrowing was made in: its query is searched there, and its layers can be copied. */
  viewId: string
  viewName: string
  workspaceId: string
  dataSourceId?: string
  draft: NarrowDraft
  /** How many layers the view it is made from has. */
  sourceLayerCount: number
  /** Beside the title: keep it live instead, where a live view can (Save as view's switch). */
  headerExtra?: ReactNode
  onClose: () => void
  onSaved: (view: View) => void
}

const CARDS: Record<LayoutChoice, { icon: keyof typeof LucideIcons; title: (viewName: string) => string; hint: string }> = {
  source: { icon: 'Columns3', title: (v) => `Like “${v}”`, hint: 'Its layers, each member placed where that view places it' },
  template: { icon: 'LayoutTemplate', title: () => 'From a template', hint: 'A layout template’s layers and rules' },
  auto: { icon: 'Shapes', title: () => 'By type', hint: 'A layer for each kind of top-level entity' },
  stages: { icon: 'Workflow', title: () => 'Lineage stages', hint: 'Sources · Feeds · Starting points · Consumers · Impact' },
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

/** The server's own words for a refused save, where it gave some. */
function saveErrorText(err: unknown): string {
  const detail = (err as { detail?: unknown } | null)?.detail
  if (detail && typeof detail === 'object' && typeof (detail as { message?: unknown }).message === 'string') {
    return (detail as { message: string }).message
  }
  if (typeof detail === 'string') return detail
  const status = httpStatusOf(err)
  if (status === 403) return 'You can’t create views in this workspace.'
  if (status === 503) return 'The graph couldn’t answer in full in time, so nothing was saved. Try again in a moment.'
  return narrowErrorText(err)
}

export function SaveAsViewSheet({
  viewId, viewName, workspaceId, dataSourceId, draft, sourceLayerCount, headerExtra, onClose, onSaved,
}: SaveAsViewSheetProps) {
  const spec = draft.spec
  const sentence = describeNarrow(spec, draft.seedsLabel)
  const templatesEnabled = useLayoutTemplatesEnabled()
  const offers = layoutOffers(spec, sourceLayerCount, templatesEnabled)
  const firstOffer = offers.find((o) => o.available)?.choice ?? 'auto'

  const [name, setName] = useState(() => capitalise(sentence).slice(0, 120))
  const [live, setLive] = useState(true)
  const [visibility, setVisibility] = useState<'private' | 'workspace'>('private')
  const [choices, setChoices] = useState<SaveChoices>({ choice: firstOffer, keep: 'withResults', nest: true })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One per sheet: a retry of this save answers with the view the first attempt made.
  const [idempotencyKey] = useState(() => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`))

  const { templates, isLoading: templatesLoading } = useLayoutTemplates({ enabled: choices.choice === 'template' })
  const declared = useSchemaEntityTypes()
  const declaredIds = useMemo(() => declared.map((t) => t.id), [declared])
  const template = templates.find((t) => t.id === choices.templateId) ?? null
  const fit = useMemo(() => (template ? fitTemplate(template.layers, declaredIds.length ? declaredIds : null) : null), [template, declaredIds])

  const withTemplate: SaveChoices = { ...choices, templateLayers: fit?.layers as Array<Record<string, unknown>> | undefined }
  const request = choices.choice === 'template' && !fit ? null : planRequestOf(spec, viewId, withTemplate)
  const { state, retry } = usePlanPreview(viewId, request)
  const plan = state.status === 'ready' ? state.plan : state.status === 'loading' ? state.last : null
  const loading = state.status === 'loading'
  const ready = state.status === 'ready' && !state.plan.overCap && state.plan.keys > 0
  const canSave = ready && !!name.trim() && !saving

  const choose = (choice: LayoutChoice) => setChoices((c) => ({ ...c, choice }))

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    try {
      const out = await createFromMembers(createRequestOf({
        name, visibility, mode: live ? 'live' : 'snapshot', workspaceId, dataSourceId,
        spec, viewId, choices: withTemplate, origin: spec.seeds.query ? 'search' : 'narrow',
      }), idempotencyKey)
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
    choose(to)
    document.getElementById(`save-as-view-layout-${to}`)?.focus()
  }

  return createPortal(
    <>
      <Backdrop open={true} onClick={saving ? () => {} : onClose} zClassName="z-50" className="bg-black/40 backdrop-blur-[2px]" />
      <motion.aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-as-view-title"
        initial={{ x: 560 }}
        animate={{ x: 0 }}
        transition={MOTION.drawerSlide}
        className="fixed right-0 top-0 z-50 h-full w-[560px] max-w-[100vw] flex flex-col bg-canvas-elevated border-l border-glass-border shadow-2xl shadow-black/25"
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !saving) { e.stopPropagation(); onClose() }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void save() }
        }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-7 pt-6 pb-4 border-b border-glass-border/60">
          <div className="flex items-start gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-2xl bg-accent-lineage/[0.12] border border-accent-lineage/25 grid place-items-center flex-none">
              <LucideIcons.BookmarkPlus className="w-5 h-5 text-accent-lineage" strokeWidth={2.2} />
            </div>
            <div className="min-w-0">
              <h2 id="save-as-view-title" className="text-xl font-display font-semibold text-ink leading-tight">Save as a view</h2>
              <p className="text-[13px] text-ink-muted mt-0.5 leading-snug">A view of its own on the same data, with its own layers, sharing and history.</p>
              {headerExtra && <div className="mt-3">{headerExtra}</div>}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-40">
            <LucideIcons.X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-7 py-5 space-y-6">
          {/* What it is */}
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
              Made from <span className="text-ink">{sentence}</span>.
            </p>
          </Section>

          {/* Up to date, or as it is */}
          <div className="flex items-start justify-between gap-4 rounded-2xl border border-glass-border/80 px-4 py-3.5">
            <span className="flex items-start gap-3 min-w-0">
              <span className={cn('mt-0.5 w-8 h-8 rounded-xl grid place-items-center flex-none', live ? 'bg-accent-lineage/12 text-accent-lineage' : 'bg-black/[0.05] dark:bg-white/[0.07] text-ink-muted')}>
                {live ? <LucideIcons.RefreshCw className="w-4 h-4" /> : <LucideIcons.Snowflake className="w-4 h-4" />}
              </span>
              <span className="min-w-0">
                <span id="save-as-view-live" className="block text-[13.5px] font-semibold text-ink leading-tight">
                  {live ? 'Keeps itself up to date' : 'A snapshot'}
                </span>
                <span className="block mt-0.5 text-[12px] text-ink-muted leading-snug">
                  {live
                    ? 'As the data changes, what newly matches arrives and what stops matching leaves. Where you move things stays.'
                    : 'Keeps the members it has now. You can resume updates later.'}
                </span>
              </span>
            </span>
            <Switch checked={live} onChange={setLive} labelledBy="save-as-view-live" />
          </div>

          {/* Layout */}
          <Section title="Layout">
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Layout">
              {offers.map((offer) => {
                const card = CARDS[offer.choice]
                const Icon = LucideIcons[card.icon] as LucideIcons.LucideIcon
                const on = choices.choice === offer.choice
                return (
                  <button
                    key={offer.choice}
                    id={`save-as-view-layout-${offer.choice}`}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    tabIndex={on ? 0 : -1}
                    disabled={!offer.available}
                    title={offer.reason}
                    onClick={() => choose(offer.choice)}
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
                    <span className="text-[13px] font-semibold text-ink leading-tight truncate max-w-full">{card.title(viewName)}</span>
                    <span className="text-[11.5px] text-ink-muted leading-snug">{offer.available ? card.hint : offer.reason}</span>
                  </button>
                )
              })}
            </div>

            <div className="mt-3 space-y-2.5">
              {choices.choice === 'template' && (
                <TemplateList
                  loading={templatesLoading}
                  templates={templates.map((t) => ({ id: t.id, name: t.name, layers: t.layers.length, fit: fitTemplate(t.layers, declaredIds.length ? declaredIds : null) }))}
                  value={choices.templateId}
                  onChange={(templateId) => setChoices((c) => ({ ...c, templateId }))}
                />
              )}
              {(choices.choice === 'source' || choices.choice === 'stages') && (
                <OptionRow title="Layers" hint={choices.keep === 'withResults' ? 'Only the layers something lands in' : 'Every layer, empty ones too'}>
                  <Segmented
                    label="Which layers to keep"
                    value={choices.keep}
                    onChange={(keep) => setChoices((c) => ({ ...c, keep }))}
                    options={[{ value: 'withResults', label: 'With results' }, { value: 'all', label: 'All' }]}
                  />
                </OptionRow>
              )}
              <OptionRow title="Show where they sit" hint="Draw each entity inside the containers it lives in">
                <Switch checked={choices.nest} onChange={(nest) => setChoices((c) => ({ ...c, nest }))} label="Show where they sit" />
              </OptionRow>
            </div>
          </Section>

          {/* Preview */}
          <Section title="Preview">
            <Preview
              state={state}
              plan={plan}
              loading={loading}
              waitingForTemplate={choices.choice === 'template' && !fit}
              help={plan ? overLimitHelp(plan, spec, choices.nest) : []}
              seedNote={seedCapNote(plan)}
              onRetry={retry}
            />
          </Section>

          {/* Who can see it */}
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

        {/* Footer */}
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
            {/* The count against the limit, always in sight. */}
            <p className={cn('min-w-0 truncate text-[12px] tabular-nums', plan?.overCap ? 'text-red-600 dark:text-red-400 font-medium' : 'text-ink-muted', loading && 'opacity-60')}>
              {plan ? meterText(plan) : 'Working out what it holds…'}
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

function OptionRow({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-glass-border/70 px-4 py-2.5">
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-ink leading-tight">{title}</span>
        <span className="block text-[11.5px] text-ink-muted leading-snug">{hint}</span>
      </span>
      {children}
    </div>
  )
}

/** A small switch: the words beside it name it. */
function Switch({ checked, onChange, label, labelledBy }: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  labelledBy?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      onClick={() => onChange(!checked)}
      className="relative inline-flex h-9 w-11 flex-none items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
    >
      <span className={cn('flex h-5 w-9 items-center rounded-full transition-colors duration-150', checked ? 'bg-accent-lineage' : 'bg-black/15 dark:bg-white/20')}>
        <span className={cn('h-4 w-4 rounded-full bg-white shadow-md transition-transform duration-150', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}

function TemplateList({ loading, templates, value, onChange }: {
  loading: boolean
  templates: Array<{ id: string; name: string; layers: number; fit: ReturnType<typeof fitTemplate> }>
  value?: string
  onChange: (id: string) => void
}) {
  if (loading) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-glass-border/70 px-4 py-3 text-[12.5px] text-ink-muted">
        <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading templates…
      </p>
    )
  }
  if (templates.length === 0) {
    return <p className="rounded-xl border border-glass-border/70 px-4 py-3 text-[12.5px] text-ink-muted">No layout templates you can use yet.</p>
  }
  return (
    <ul role="radiogroup" aria-label="Template" className="max-h-48 overflow-y-auto custom-scrollbar rounded-xl border border-glass-border/70 divide-y divide-glass-border/50">
      {templates.map((t) => {
        const on = t.id === value
        const partial = t.fit.typedLayers > 0 && t.fit.matchedLayers < t.fit.typedLayers
        return (
          <li key={t.id}>
            <button
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(t.id)}
              className={cn('w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left transition-colors', on ? 'bg-accent-lineage/[0.08]' : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]')}
            >
              <span className="flex items-center gap-2.5 min-w-0">
                <span className={cn('w-4 h-4 rounded-full border grid place-items-center flex-none', on ? 'border-accent-lineage bg-accent-lineage' : 'border-glass-border')}>
                  {on && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                </span>
                <span className="truncate text-[13px] text-ink">{t.name}</span>
              </span>
              <span className={cn('flex-none text-[11.5px] tabular-nums', partial ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted')}>
                {t.fit.typedLayers > 0 ? `Fits ${t.fit.matchedLayers} of ${t.fit.typedLayers} layers` : `${t.layers} ${t.layers === 1 ? 'layer' : 'layers'}`}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** What the view would start with: its layers and what each holds, against the limit. */
function Preview({ state, plan, loading, waitingForTemplate, help, seedNote, onRetry }: {
  state: ReturnType<typeof usePlanPreview>['state']
  plan: MembershipPlan | null
  loading: boolean
  waitingForTemplate: boolean
  help: string[]
  seedNote: string | null
  onRetry: () => void
}) {
  if (waitingForTemplate) {
    return <p className="rounded-xl border border-glass-border/70 px-4 py-3 text-[13px] text-ink-muted">Choose a template to see what the view would start with.</p>
  }
  if (state.status === 'error') {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[13px] text-red-600 dark:text-red-400">
        <span>{state.message}</span>
        <button type="button" onClick={onRetry} className="flex-none font-semibold underline-offset-2 hover:underline">Try again</button>
      </div>
    )
  }
  if (!plan) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-glass-border/70 px-4 py-3 text-[13px] text-ink-muted">
        <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" /> Working out the layers it would start with…
      </div>
    )
  }
  const share = Math.min(1, plan.keys / Math.max(plan.limit, 1))
  const notes = truncationNotes({ truncated: plan.truncated.filter((t) => t.reason !== 'seed_cap') })
  return (
    <div className={cn('rounded-xl border px-4 py-3.5 space-y-3 transition-opacity', plan.overCap ? 'border-red-500/35' : 'border-glass-border/70', loading && 'opacity-60')}>
      {/* The layers, as columns */}
      <div className="flex gap-2 overflow-x-auto custom-scrollbar pb-1" aria-label="The layers it would start with">
        {plan.layers.map((layer) => (
          <div
            key={layer.id}
            className={cn('w-[112px] flex-none rounded-lg border border-glass-border/70 overflow-hidden', !layer.kept && 'opacity-45')}
            title={layer.kept ? undefined : 'Left out: nothing lands in it'}
          >
            <span className="block h-1" style={{ backgroundColor: layer.color ?? '#94a3b8' }} />
            <span className="block px-2.5 pt-1.5 text-[11.5px] font-semibold text-ink truncate">{layer.name || 'Layer'}</span>
            <span className="block px-2.5 pb-2 text-[11px] text-ink-muted tabular-nums">
              {layer.kept ? `${layer.count.toLocaleString()} ${layer.count === 1 ? 'entry' : 'entries'}` : 'left out'}
            </span>
          </div>
        ))}
      </div>
      {plan.fallback > 0 && (
        <p className="text-[12px] text-ink-muted">
          {plan.fallback.toLocaleString()} {plan.fallback === 1 ? 'has' : 'have'} no layer of their own — an “Other” layer holds them.
        </p>
      )}

      {/* Against the limit */}
      <div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.06]" aria-hidden="true">
          <motion.span
            className={cn('h-full rounded-full', plan.overCap ? 'bg-red-500' : share > 0.8 ? 'bg-amber-500' : 'bg-accent-lineage')}
            initial={false}
            animate={{ width: `${Math.max(share * 100, plan.keys ? 2 : 0)}%` }}
            transition={MOTION.collapse}
          />
        </div>
        <p className={cn('mt-1.5 text-[12px] tabular-nums', plan.overCap ? 'text-red-600 dark:text-red-400 font-medium' : 'text-ink-muted')}>
          {meterText(plan)}
        </p>
      </div>

      {plan.overCap && (
        <div className="rounded-lg bg-red-500/[0.05] px-3 py-2.5">
          <p className="text-[12.5px] font-semibold text-red-600 dark:text-red-400">More than a view can hold, so it can’t be saved as it is.</p>
          <ul className="mt-1 space-y-0.5 text-[12px] text-ink-secondary list-disc pl-4">
            {help.map((h) => <li key={h}>{h}</li>)}
          </ul>
        </div>
      )}
      {(seedNote || notes.length > 0 || plan.missingSeeds > 0) && (
        <ul className="space-y-1 text-[12px] text-amber-700 dark:text-amber-400">
          {seedNote && <li>{seedNote}</li>}
          {plan.missingSeeds > 0 && <li>{plan.missingSeeds.toLocaleString()} chosen {plan.missingSeeds === 1 ? 'entity no longer exists' : 'entities no longer exist'} — left out.</li>}
          {notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
      {plan.keys === 0 && !plan.overCap && <p className="text-[12.5px] text-ink-muted">Nothing to save — the narrowing holds no entities.</p>}
    </div>
  )
}
