/**
 * The semantic layer of a new data source copied from a view package.
 *
 * A package that comes from THIS environment names its own layer, and the server finds it here
 * (`ontologyMatch.exact`): that one is chosen, with a note when it changed since the export
 * (`drift`). Anything else — another environment, or a layer no longer here — runs the same
 * matching the onboarding wizards do: the package's type stats (`typeStats`, the shape a
 * provider's stats take) scored against every layer by `/ontologies/suggest`, the best fit that
 * covers anything chosen, and the same cards with the same coverage numbers to choose another.
 * "Create from this package" saves the suggestion as a draft layer (as onboarding does) and
 * chooses it: a new data source may be bound to a draft. "No semantic layer" is always a choice.
 *
 * While the scores load, or when they can't be had (no right to score layers, say), the list is
 * still a manual choice: the exact match stays chosen, and every layer is a plain card.
 */
import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, BookOpen, Check, Info, Loader2, Sparkles, Wand2 } from 'lucide-react'
import { useOntologies } from '@/features/ontology/hooks/useOntologies'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import { bestFitId, useOntologyMatches } from '@/components/wizard/useOntologyMatches'
import { OntologyMatchList } from '@/components/wizard/OntologyMatchList'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { OntologyMatch, PackageTypeStats } from '@/services/viewTransferApiService'

export function PackageOntologyPicker({ match, typeStats, value, onChange, draftName, onPending }: {
  /** The package source's own layer here, as the server matched it (absent: none known). */
  match: OntologyMatch | null
  /** What the package's data holds by type: what the layers are scored against. */
  typeStats: PackageTypeStats | null
  /** Undefined until chosen (the recommendation is chosen then); null for no semantic layer. */
  value: string | null | undefined
  onChange: (ontologyId: string | null) => void
  /** What a layer created from the package is called. */
  draftName: string
  /** Told while the recommendation is still being worked out and nothing is chosen, so the step
   *  can wait for it instead of sending "no semantic layer" by default. */
  onPending?: (pending: boolean) => void
}) {
  const exact = match?.exact ?? null
  // The package's own layer needs no scoring; choosing another one does (and one chosen stays so).
  const [choosing, setChoosing] = useState(false)
  const showList = !exact || choosing || (value !== undefined && value !== exact.ontologyId)
  const matching = useOntologyMatches({ stats: typeStats, enabled: !!typeStats && showList })
  const ontologiesQuery = useOntologies()
  const { create } = useOntologyMutations()
  const [created, setCreated] = useState<OntologyDefinitionResponse | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  // Drafts too: a new data source may be bound to one. The one just created is listed at once.
  const ontologies = useMemo(() => {
    const live = (ontologiesQuery.data ?? []).filter(o => !o.deletedAt)
    return created && !live.some(o => o.id === created.id) ? [created, ...live] : live
  }, [ontologiesQuery.data, created])

  // Recommend once, and only while nothing is chosen: the package's own layer, else the best fit
  // that covers anything (never a 0% one). A choice made since — "none" included — stands. The
  // scores span every layer, so the best fit is chosen only when it is one of the cards listed
  // (the layers this user can see): never one no card shows, nor one the server would refuse.
  const best = bestFitId(matching)
  const bestListed = !!best && ontologies.some(o => o.id === best)
  useEffect(() => {
    if (value !== undefined) return
    if (exact) onChange(exact.ontologyId)
    else if (matching.phase === 'ready' && bestListed) onChange(best)
  }, [value, exact, matching.phase, best, bestListed, onChange])
  const pending = value === undefined && !exact && !!typeStats
    && (matching.phase === 'idle' || matching.phase === 'analyzing' || !!ontologiesQuery.isLoading)
  useEffect(() => { onPending?.(pending) }, [pending, onPending])
  useEffect(() => () => onPending?.(false), [onPending])

  const createFromPackage = async () => {
    const suggested = matching.response?.suggested
    if (!suggested) return
    setCreateError(null)
    try {
      const layer = await create.mutateAsync({ ...suggested, name: draftName })
      setCreated(layer)
      onChange(layer.id)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'The semantic layer couldn’t be created.')
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <Sparkles className="w-3.5 h-3.5 text-slate-400 shrink-0" />
        <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Semantic layer</span>
      </div>

      {exact && (
        <div className="flex items-start gap-3 rounded-xl border-2 border-blue-500/60 bg-blue-50/50 dark:bg-blue-950/20 px-4 py-3">
          <BookOpen className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 text-xs">
            <p className="text-sm font-semibold text-ink">
              {exact.name} <span className="font-normal text-ink-muted">v{exact.version}</span>
            </p>
            <p className="text-[11px] text-ink-muted mt-0.5">
              The package’s own semantic layer: it was exported from this environment, where this layer lives.
            </p>
            {match?.drift && (
              <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
                It has changed since the package was exported. The data is checked against it as it is now, and anything it
                no longer declares is kept.
              </p>
            )}
          </div>
          {value === exact.ontologyId ? (
            <span className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 dark:text-blue-400">
              <Check className="w-3.5 h-3.5" /> Chosen
            </span>
          ) : (
            <button type="button" onClick={() => onChange(exact.ontologyId)}
              className="shrink-0 text-[11px] font-semibold text-blue-600 dark:text-blue-400 hover:underline">
              Use it
            </button>
          )}
        </div>
      )}
      {exact && !showList && (
        <button type="button" onClick={() => setChoosing(true)}
          className="text-xs font-semibold text-slate-600 dark:text-slate-300 hover:text-blue-600 dark:hover:text-blue-400">
          Choose another semantic layer
        </button>
      )}

      {showList && (
        <>
          {matching.phase === 'analyzing' && (
            <div className="flex items-center gap-3 rounded-xl border border-slate-200 dark:border-slate-700 px-4 py-3">
              <Loader2 className="w-4 h-4 text-blue-500 animate-spin shrink-0" />
              <p className="text-sm text-slate-600 dark:text-slate-400">Matching the package’s data against your semantic layers…</p>
            </div>
          )}
          {matching.phase === 'error' && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-4 py-3">
              <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-amber-800 dark:text-amber-300">{matching.error}</p>
                <p className="text-[11px] text-amber-700/80 dark:text-amber-400/80 mt-1">
                  You can still choose a layer by hand — it just won't be scored.
                </p>
              </div>
            </div>
          )}
          {matching.phase === 'ready' && (
            <div className="flex items-center gap-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/50 px-4 py-2.5">
              <Info className="w-3.5 h-3.5 text-blue-500 shrink-0" />
              {/* The denominator behind every percentage below. */}
              <p className="text-xs text-slate-600 dark:text-slate-400">
                The package’s data has <span className="font-bold text-slate-900 dark:text-white">{matching.graphCounts.entities}</span> entity
                {' '}type{matching.graphCounts.entities === 1 ? '' : 's'} and
                {' '}<span className="font-bold text-slate-900 dark:text-white">{matching.graphCounts.rels}</span> relationship
                {' '}type{matching.graphCounts.rels === 1 ? '' : 's'}. Layers are ranked by how much of it they cover; what one
                doesn’t declare is kept, not rejected.
              </p>
            </div>
          )}

          <OntologyMatchList
            ontologies={ontologies}
            matching={matching}
            selectedId={value ?? ''}
            onPick={id => onChange(id || null)}
            none={{ title: 'No semantic layer', subtitle: 'Keep the data’s own types', meta: 'Choose one later if you like' }}
          />

          {matching.phase === 'ready' && matching.response && created === null && (
            <button type="button" onClick={() => void createFromPackage()} disabled={create.isPending}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 disabled:opacity-60">
              {create.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wand2 className="w-3.5 h-3.5" />}
              Create from this package
            </button>
          )}
          {created && (
            <p className="text-[11px] text-ink-muted">
              “{created.name}” was created as a draft from the package’s types, and chosen. Publish it from Semantic layers when it’s ready.
            </p>
          )}
          {createError && <p className="text-[11px] text-rose-500">{createError}</p>}
        </>
      )}
    </section>
  )
}
