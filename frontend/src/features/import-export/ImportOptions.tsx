/**
 * ImportOptions — how an import's rows are applied: how it reconciles (add & update, or replace),
 * what its rows find existing items by (the graph's default unless another is chosen), and, where
 * the import may publish itself, whether it waits in a draft instead. Each section shows when its
 * caller offers it; matching is always there.
 */
import { AlertTriangle, ShieldAlert, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ImportSettings, ReconcileMode } from '@/services/importExportApiService'
import { MATCH_KINDS, parseIdentifier, type Match } from './identifier'

/** Why a property can't be matched by (Import is then off), what matching by it first costs, or why
 *  a fork's default isn't its parent's. */
export function matchNote(match: Match | null, settings: ImportSettings | null): { block: boolean; text: string } | null {
  if (!match && settings?.effective.sources.identifier === 'fork') {
    return { block: false, text: 'This fork matches by Entity ID: its parent’s default is a property, and a '
      + 'fork can’t match by one yet.' }
  }
  if (match?.kind !== 'prop') return null
  const name = match.name.trim()
  if (!name) return { block: true, text: 'Name the property its rows are matched by.' }
  if (!settings) return null
  const known = settings.matchingProperties.find((p) => p.name === name)
  if (known?.status === 'ready') return null
  if (!known && settings.matchingProperties.length >= settings.maxMatchingProperties) {
    return { block: true, text: `This graph's imports already match by ${settings.maxMatchingProperties} `
      + 'properties, its most: match by one of them, by Entity ID or by URN.' }
  }
  return { block: false, text: `No import has matched by ${name} yet: this one indexes it first, reading `
    + 'every item once (minutes on a large graph). Later ones only catch up.' }
}

export function ImportOptions({ reconcile, match, onMatch, graphDefault, note, keyedOnly, draft }: {
  /** How it reconciles; absent where it only adds and updates. `viewScoped`: a replace deletes
   *  only within the view. */
  reconcile?: { mode: ReconcileMode; onChange: (m: ReconcileMode) => void; viewScoped: boolean }
  match: Match | null
  onMatch: (m: Match) => void
  /** The graph's default identifier; null while it isn't known (the server applies it). */
  graphDefault: string | null
  note: { block: boolean; text: string } | null
  /** A replace by a property: delete only the items that hold it. */
  keyedOnly?: { value: boolean; onChange: (v: boolean) => void }
  /** An import that would publish itself: keep it in a draft instead. */
  draft?: { keep: boolean; onChange: (keep: boolean) => void; label: string; help: string }
}) {
  const fallback = graphDefault ? parseIdentifier(graphDefault) : null
  const shown = match ?? fallback
  const viewScoped = !!reconcile?.viewScoped
  // A replace that deletes only what holds the property: the property's name.
  const keyed = keyedOnly?.value && shown?.kind === 'prop' ? shown.name.trim() || 'this property' : null
  return (
    <>
      {reconcile && (
        <div>
          <label className="block text-xs font-medium text-ink-secondary mb-2">How should it reconcile?</label>
          <div className="space-y-2">
            <ModeCard active={reconcile.mode === 'upsert'} onClick={() => reconcile.onChange('upsert')}
              icon={<Sparkles className="w-4 h-4" />} title="Add & update" tone="indigo"
              desc="Creates new items and updates matching ones. Never deletes — safe default." />
            <ModeCard active={reconcile.mode === 'replace'} onClick={() => reconcile.onChange('replace')}
              icon={<ShieldAlert className="w-4 h-4" />} title="Replace (authoritative)" tone="amber"
              desc={keyed
                ? `Removes ${viewScoped ? "this view's" : 'the'} items that have ${keyed} and aren't in your file; items without it are left alone.`
                : viewScoped
                ? "The file is the source of truth for this view — its items missing from the file are deleted."
                : "The file becomes the source of truth — items missing from it are deleted."} />
          </div>
          {reconcile.mode === 'replace' && (
            <div className="mt-2 flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800/50 bg-amber-50/60 dark:bg-amber-950/20 px-3 py-2 animate-in fade-in duration-150">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
              <p className="text-[11px] text-amber-700 dark:text-amber-400">
                {viewScoped
                  ? "Only entities in this view can be deleted — the rest of the data source is untouched. You'll review the exact count before publishing."
                  : "You'll see exactly what would be deleted in the review before anything is published."}
              </p>
            </div>
          )}
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-ink-secondary mb-2">Match existing items by</label>
        <div role="radiogroup" aria-label="Match existing items by"
          className="flex items-center gap-1 rounded-xl bg-black/[0.03] dark:bg-white/[0.04] p-1">
          {MATCH_KINDS.map((m) => (
            <button key={m.kind} type="button" role="radio" aria-checked={shown?.kind === m.kind}
              onClick={() => shown?.kind !== m.kind && onMatch({ kind: m.kind, name: m.kind === 'prop' ? (shown?.name ?? '') : '' })}
              className={cn('flex-1 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-colors',
                shown?.kind === m.kind ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink')}>
              {m.label}{fallback?.kind === m.kind && <>{' '}<span className="font-normal text-ink-muted">· default</span></>}
            </button>
          ))}
        </div>
        {shown?.kind === 'prop' && (
          <>
            <input aria-label="Property name" placeholder="external_id" value={shown.name}
              onChange={(e) => onMatch({ ...shown, kind: 'prop', name: e.target.value })}
              className="mt-2 w-full px-2.5 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border text-[12px] font-mono text-ink focus:outline-none focus:border-indigo-500/50" />
            <label className="mt-2 flex items-start gap-2 text-[11px] text-ink-muted leading-relaxed cursor-pointer">
              <input type="checkbox" checked={!!shown.orUrn}
                onChange={(e) => onMatch({ ...shown, kind: 'prop', orUrn: e.target.checked })}
                className="mt-0.5 accent-indigo-500" />
              <span>
                <span className="font-medium text-ink-secondary">Rows without it: find them by their urn.</span>{' '}
                For an item your source has no id for, such as a top-level container. An item found
                by its urn takes the property, so the next import finds it by the property.
              </span>
            </label>
            {reconcile?.mode === 'replace' && keyedOnly && (
              <label className="mt-1.5 flex items-start gap-2 text-[11px] text-ink-muted leading-relaxed cursor-pointer">
                <input type="checkbox" checked={keyedOnly.value} onChange={(e) => keyedOnly.onChange(e.target.checked)}
                  className="mt-0.5 accent-amber-500" />
                <span>
                  <span className="font-medium text-ink-secondary">Delete only items that have this property.</span>{' '}
                  Items made in the app or by another source, which never had it, are left alone.
                </span>
              </label>
            )}
          </>
        )}
        <p className="text-[11px] text-ink-muted mt-1.5 leading-relaxed">
          {shown ? MATCH_KINDS.find((m) => m.kind === shown.kind)!.help
            : 'This graph’s default applies, unless you choose another.'}
        </p>
        {note && (
          <p className={cn('text-[11px] mt-1 leading-relaxed', note.block ? 'text-amber-700 dark:text-amber-400' : 'text-ink-muted')}>
            {note.text}
          </p>
        )}
      </div>

      {draft && (
        <label className="flex items-start gap-2 text-[11px] text-ink-muted leading-relaxed cursor-pointer">
          <input type="checkbox" checked={draft.keep} onChange={(e) => draft.onChange(e.target.checked)}
            className="mt-0.5 accent-indigo-500" />
          <span>
            <span className="font-medium text-ink-secondary">{draft.label}</span>{' '}{draft.help}
          </span>
        </label>
      )}
    </>
  )
}

function ModeCard(props: {
  active: boolean; onClick: () => void; icon: React.ReactNode; title: string; desc: string; tone: 'indigo' | 'amber'
}) {
  const activeRing = props.tone === 'indigo'
    ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
    : 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20 shadow-sm shadow-amber-500/10'
  const activeChip = props.tone === 'indigo'
    ? 'bg-indigo-100 dark:bg-indigo-900/50 text-indigo-500'
    : 'bg-amber-100 dark:bg-amber-900/50 text-amber-500'
  return (
    <button type="button" onClick={props.onClick}
      className={cn('w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
        props.active ? activeRing : 'border-glass-border hover:border-glass-border-hover')}>
      <div className="flex items-center gap-3">
        <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
          props.active ? activeChip : 'bg-black/5 dark:bg-white/5 text-ink-muted')}>
          {props.icon}
        </div>
        <div className="flex-1">
          <span className="text-sm font-semibold text-ink">{props.title}</span>
          <p className="text-[11px] text-ink-muted mt-0.5">{props.desc}</p>
        </div>
      </div>
    </button>
  )
}
