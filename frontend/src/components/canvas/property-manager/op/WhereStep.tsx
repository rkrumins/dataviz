/**
 * Step 2 — Where: which entities the change reaches. The ways in are ready-made — the whole view,
 * every entity with the property, the canvas selection, a layer, a container's children or
 * everything inside it, a search's matches — or criteria built like any search. In the view by
 * default; the whole data source on purpose, behind a warning. A change of relationships reaches
 * the ones it was opened on: those picked, or a Connections search's.
 */
import { useMemo, type ComponentType, type ReactNode } from 'react'
import { AlertTriangle, Filter, FolderTree, Globe2, Layers, ListChecks, ListTree, MousePointerSquareDashed, ScanSearch, Tag, Waypoints } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Segmented } from '@/components/ui/Segmented'
import type { Predicate } from '@/types/search'
import { useDiscovery } from '../../search/builder/useDiscovery'
import { VisualQueryBuilder } from '../../search/panel/VisualQueryBuilder'
import { scopeFixedToView, tooManyIds, type OpDraft, type ScopeMode, type TargetPreset } from './opModel'
import { FIELD, LABEL } from './styles'

export interface LayerOption { id: string; name: string }

interface Choice {
  id: TargetPreset['kind']
  icon: ComponentType<{ className?: string }>
  title: string
  detail: string
  preset: TargetPreset
  extra?: ReactNode
}

export function WhereStep({
  viewId, preset, onPreset, scopeMode, onScope, sourceConfirmed, onConfirmSource, op, selectionIds, layers, seed,
  knownEntityTypes,
}: {
  viewId: string
  preset: TargetPreset
  onPreset: (preset: TargetPreset) => void
  scopeMode: ScopeMode
  onScope: (scope: ScopeMode) => void
  /** The reader has said a change across the whole data source is meant. */
  sourceConfirmed: boolean
  onConfirmSource: (confirmed: boolean) => void
  op: OpDraft
  /** The canvas selection now. */
  selectionIds: readonly string[]
  layers: readonly LayerOption[]
  /** The target the dialog was opened with (a container, a search). */
  seed?: TargetPreset
  knownEntityTypes: string[]
}) {
  const key = op.key.trim()
  const choices = useMemo(() => {
    const out: Choice[] = []
    // Relationships: the ones it was opened on — nothing here reaches others.
    if (seed?.kind === 'relationships' || seed?.kind === 'connections') {
      out.push(seed.kind === 'relationships'
        ? { id: seed.kind, icon: Waypoints, title: `The ${seed.ids.length.toLocaleString()} relationships`, detail: 'Exactly the relationships picked', preset: seed }
        : { id: seed.kind, icon: ScanSearch, title: 'The search’s relationships',
          detail: `Every relationship it matches${seed.count !== undefined ? ` — ${seed.count.toLocaleString()}` : ''}, on every page`, preset: seed })
      return out
    }
    if (seed && (seed.kind === 'children' || seed.kind === 'inside' || seed.kind === 'search')) {
      out.push({
        id: seed.kind,
        icon: seed.kind === 'search' ? ScanSearch : seed.kind === 'children' ? ListTree : FolderTree,
        title: seed.kind === 'search' ? sentence(seed.label) : seed.kind === 'children' ? `The children of ${seed.label}` : `Everything inside ${seed.label}`,
        detail: seed.kind === 'search' ? `Every match${seed.count !== undefined ? ` — ${seed.count.toLocaleString()}` : ''}, on every page`
          : seed.kind === 'children' ? 'One level down — not their own children' : 'Every level down, however deep (up to 20)',
        preset: seed,
      })
      if (seed.kind === 'children' || seed.kind === 'inside') {
        const other: TargetPreset = seed.kind === 'children'
          ? { kind: 'inside', urns: seed.urns, label: seed.label, includeSelf: false }
          : { kind: 'children', urns: seed.urns, label: seed.label }
        out.push({
          id: other.kind,
          icon: other.kind === 'children' ? ListTree : FolderTree,
          title: other.kind === 'children' ? `The children of ${seed.label}` : `Everything inside ${seed.label}`,
          detail: other.kind === 'children' ? 'One level down — not their own children' : 'Every level down, however deep (up to 20)',
          preset: other,
        })
      }
    }
    // Ids it was opened with that aren't the canvas selection (a publish's refusals): those, by name.
    if (seed?.kind === 'selection' && seed.label) {
      out.push({ id: 'selection', icon: ListChecks, title: sentence(seed.label),
        detail: `Exactly these ${seed.ids.length.toLocaleString()}, by id — new in the draft too`, preset: seed })
    } else if (selectionIds.length > 0) {
      out.push({ id: 'selection', icon: MousePointerSquareDashed, title: `The ${selectionIds.length.toLocaleString()} selected`,
        detail: 'Exactly the entities selected on the canvas', preset: { kind: 'selection', ids: selectionIds } })
    }
    out.push({ id: 'view', icon: Globe2, title: 'Every entity in the view', detail: 'However many — not just the ones loaded', preset: { kind: 'view' } })
    if (key) {
      out.push({ id: 'hasKey', icon: Tag, title: `Every entity with ${key}`, detail: 'The entities that hold it already', preset: { kind: 'hasKey', key } })
    }
    if (layers.length > 0) {
      const layerId = preset.kind === 'layer' ? preset.layerId : layers[0]!.id
      out.push({
        id: 'layer', icon: Layers, title: 'A layer', detail: 'Every entity the view places in it',
        preset: { kind: 'layer', layerId, name: layers.find((l) => l.id === layerId)?.name ?? layerId },
      })
    }
    out.push({ id: 'custom', icon: Filter, title: 'Entities matching criteria', detail: 'Any conditions, built as a search is',
      preset: preset.kind === 'custom' ? preset : { kind: 'custom', predicate: null } })
    return out
  }, [seed, selectionIds, key, layers, preset])

  const fixed = scopeFixedToView(preset)
  const tooMany = tooManyIds(preset)
  return (
    <div className="space-y-5">
      <div role="radiogroup" aria-label="Which entities" className="grid gap-1.5">
        {choices.map((c) => {
          const on = preset.kind === c.id
          const Icon = c.icon
          return (
            <div key={c.id} className={cn('rounded-xl border transition-colors',
              on ? 'border-accent-lineage/50 bg-accent-lineage/[0.05] shadow-sm' : 'border-black/[0.07] dark:border-white/[0.08] hover:border-black/[0.14] dark:hover:border-white/[0.16]')}>
              <button type="button" role="radio" aria-checked={on} onClick={() => onPreset(c.preset)}
                className="w-full flex items-start gap-3 px-3 py-2.5 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <span className={cn('mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                  on ? 'bg-accent-lineage/15 text-accent-lineage' : 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted')}>
                  <Icon className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold text-ink">{c.title}</span>
                  <span className="block text-[11.5px] text-ink-muted">{c.detail}</span>
                </span>
              </button>
              {on && tooMany && (
                <p className="flex items-start gap-1.5 px-3 pb-3 pl-[3.25rem] text-[11.5px] text-amber-800 dark:text-amber-200">
                  <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> {tooMany}
                </p>
              )}
              {on && c.id === 'layer' && preset.kind === 'layer' && (
                <div className="px-3 pb-3 pl-[3.25rem]">
                  <select aria-label="Layer" value={preset.layerId} className={cn(FIELD, 'h-8')}
                    onChange={(e) => onPreset({ kind: 'layer', layerId: e.target.value, name: layers.find((l) => l.id === e.target.value)?.name ?? e.target.value })}>
                    {layers.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                  </select>
                </div>
              )}
              {on && c.id === 'inside' && preset.kind === 'inside' && (
                <label className="flex items-center gap-2 px-3 pb-3 pl-[3.25rem] text-[12px] text-ink">
                  <input type="checkbox" checked={preset.includeSelf} onChange={(e) => onPreset({ ...preset, includeSelf: e.target.checked })} className="accent-indigo-500" />
                  And {preset.label} itself
                </label>
              )}
              {on && c.id === 'custom' && preset.kind === 'custom' && (
                <div className="px-3 pb-3" data-search-panel-content>
                  <CustomCriteria viewId={viewId} predicate={preset.predicate} knownEntityTypes={knownEntityTypes} layers={layers}
                    onChange={(predicate) => onPreset({ kind: 'custom', predicate })} />
                </div>
              )}
            </div>
          )
        })}
      </div>

      {preset.kind !== 'selection' && preset.kind !== 'relationships' && (
        <div>
          <span className={LABEL}>Search in</span>
          <Segmented<ScopeMode>
            label="Search in"
            value={fixed ? 'view' : scopeMode}
            onChange={onScope}
            options={[
              { value: 'view', label: 'This view' },
              { value: 'data_source', label: 'The whole data source', disabled: fixed },
            ]}
          />
          {fixed && <p className="mt-1.5 text-[11.5px] text-ink-muted">A layer belongs to the view, so it is searched there.</p>}
          {!fixed && scopeMode === 'data_source' && (
            <div className="mt-2 rounded-lg border border-amber-500/35 bg-amber-500/[0.07] p-2.5">
              <p className="flex items-start gap-1.5 text-[11.5px] text-amber-800 dark:text-amber-200">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
                Entities outside this view are changed too — ones you can’t see from here.
              </p>
              <label className="mt-1.5 flex items-center gap-2 text-[12px] text-ink">
                <input type="checkbox" checked={sourceConfirmed} onChange={(e) => onConfirmSource(e.target.checked)} className="accent-amber-500" />
                I mean the whole data source
              </label>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A target's words as a title: "every Table missing Owner" → "Every Table missing Owner". */
const sentence = (label: string) => label.charAt(0).toUpperCase() + label.slice(1)

function CustomCriteria({ viewId, predicate, onChange, knownEntityTypes, layers }: {
  viewId: string
  predicate: Predicate | null
  onChange: (predicate: Predicate | null) => void
  knownEntityTypes: string[]
  layers: readonly LayerOption[]
}) {
  const { allKeys, keysByEntityType, tagValues, getValueSamples } = useDiscovery(viewId)
  const discoveredLayers = useMemo(() => layers.map((l) => ({ value: l.id, label: l.name })), [layers])
  return (
    <VisualQueryBuilder
      predicate={predicate}
      onSeed={onChange}
      onCommit={onChange}
      discovery={{ allKeys, keysByEntityType, tagValues, getValueSamples }}
      knownEntityTypes={knownEntityTypes}
      discoveredLayers={discoveredLayers}
    />
  )
}
