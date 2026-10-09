/**
 * The Target step of importing a view package, when its data goes into a brand-new data source of
 * its own rather than into a draft of one here: the choice between the two, and the new source's
 * label and physical graph name.
 *
 * The label starts as the package's own source's label; the graph name as the package's graph name
 * marked as its copy (`lineage_copy`, derived by the wizard), checked live on the connection chosen
 * below it (useGraphNameCheck, as a blank model's is): a derived name that's taken moves to a free
 * one on its own, a typed one gets the free one offered. The copy is independent: nothing ties it to
 * where it was exported from.
 */
import { useMemo } from 'react'
import { AlertCircle, AlertTriangle, Check, Database, DatabaseZap, Loader2, PlusCircle, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useGraphNameCheck, type GraphNameFields } from '../steps/useGraphNameCheck'

/** The new data source as it's being described on the Target step. */
export interface NewSourceDraft extends GraphNameFields {
  /** Undefined until the person types one: the package's own label stands. */
  label?: string
  /** Undefined until chosen (or recommended); then a semantic layer's id, or null for none. */
  ontologyId?: string | null
}

/** Where a package's data goes: into a draft of a data source here, or a new one of its own. */
export function DataTargetToggle({ mode, onChange }: {
  mode: 'existing' | 'new'
  onChange: (mode: 'existing' | 'new') => void
}) {
  const options = [
    { id: 'existing' as const, label: 'Into a data source here', icon: <Database className="w-4 h-4" /> },
    { id: 'new' as const, label: 'Into a new data source', icon: <PlusCircle className="w-4 h-4" /> },
  ]
  return (
    <div className="flex justify-center mb-3">
      <div role="radiogroup" aria-label="Where the package’s data goes"
        className="inline-flex items-center rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-1">
        {options.map(o => (
          <button key={o.id} type="button" role="radio" aria-checked={mode === o.id} onClick={() => onChange(o.id)}
            className={cn('flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors',
              mode === o.id
                ? 'bg-white dark:bg-slate-900 text-blue-600 dark:text-blue-400 shadow-sm'
                : 'text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200')}>
            {o.icon}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function NewSourceTargetPanel({ value, onChange, workspaceId, providerId, providerName, defaults, allowed }: {
  value: NewSourceDraft
  /** Merged into the draft (several can land at once: keep the merge functional). */
  onChange: (patch: Partial<NewSourceDraft>) => void
  workspaceId: string | null
  providerId: string | null
  providerName?: string | null
  /** What the package says of its source: its label, and the graph name its copy starts from. */
  defaults: { label: string; graphName: string }
  /** The person may create data sources in this workspace (`workspace:datasource:manage`). */
  allowed: boolean
}) {
  const scope = useMemo(
    () => (workspaceId && providerId ? { workspaceId, providerId } : null),
    [workspaceId, providerId],
  )
  const { nameCheck, effectiveName, autoUniquifiedFrom, isAutoName, edit, acceptSuggestion, resetToDerived } =
    useGraphNameCheck({ scope, derivedName: defaults.graphName, fields: value, update: onChange })
  const label = value.label ?? defaults.label

  return (
    <div className="mb-3 rounded-2xl border border-indigo-200/70 dark:border-indigo-900/60 bg-gradient-to-br from-indigo-50/70 to-violet-50/40 dark:from-indigo-950/25 dark:to-violet-950/10 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <DatabaseZap className="w-4 h-4 text-indigo-500" />
        <p className="text-xs font-bold text-ink">A new data source, with a full copy of the package’s data</p>
        <p className="text-[11px] text-ink-muted">Independent: nothing ties it to where it was exported from</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="block text-xs font-semibold text-ink-secondary mb-1">Label</span>
          <input type="text" value={label} onChange={(e) => onChange({ label: e.target.value })}
            aria-label="Label of the new data source" placeholder="e.g. Lineage (copy)"
            className={cn('w-full px-3 py-2 rounded-xl border-2 bg-white dark:bg-slate-800 text-sm outline-none transition-colors',
              label.trim() ? 'border-slate-200 dark:border-slate-700 focus:border-blue-500' : 'border-rose-400 dark:border-rose-500/70')} />
          {!label.trim() && <span className="block mt-1 text-[11px] text-rose-500">Give it a label.</span>}
        </label>
        <div>
          <label className="block">
            <span className="block text-xs font-semibold text-ink-secondary mb-1">
              Graph name
              {providerName && <span className="ml-1.5 font-normal text-ink-muted">on {providerName}</span>}
            </span>
            <span className={cn('flex items-center rounded-xl border-2 bg-white dark:bg-slate-800 transition-colors overflow-hidden',
              nameCheck.state === 'unavailable'
                ? 'border-rose-400 dark:border-rose-500/70'
                : nameCheck.state === 'available'
                  ? 'border-emerald-400 dark:border-emerald-500/60'
                  : 'border-slate-200 dark:border-slate-700 focus-within:border-blue-500')}>
              <input type="text" value={effectiveName} onChange={(e) => edit(e.target.value)} spellCheck={false}
                aria-label="Graph name of the new data source"
                className="flex-1 min-w-0 px-3 py-2 bg-transparent font-mono text-sm outline-none" />
              <span className="mr-3 shrink-0">
                {nameCheck.state === 'checking' && <Loader2 className="w-4 h-4 animate-spin text-slate-400" />}
                {nameCheck.state === 'available' && <Check className="w-4 h-4 text-emerald-500" />}
                {nameCheck.state === 'unavailable' && <AlertTriangle className="w-4 h-4 text-rose-500" />}
              </span>
            </span>
          </label>
          {nameCheck.state === 'unavailable' ? (
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-rose-500">
              <span className="flex-1">{nameCheck.reason}</span>
              {nameCheck.suggestion && (
                <button type="button" onClick={acceptSuggestion} className="shrink-0 font-medium text-blue-500 hover:underline">
                  Use {nameCheck.suggestion}
                </button>
              )}
            </p>
          ) : autoUniquifiedFrom && nameCheck.state === 'available' ? (
            <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              <Sparkles className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                <span className="font-mono">{autoUniquifiedFrom}</span> is already taken on this connection, so we picked{' '}
                <span className="font-mono">{effectiveName}</span>.
              </span>
            </p>
          ) : (
            <p className="mt-1 text-[11px] text-ink-muted">
              {scope ? 'The key its graph is stored under. It can’t be renamed later.' : 'Choose a connection below to check it’s free there.'}
              {!isAutoName && (
                <button type="button" onClick={resetToDerived} className="ml-1.5 text-blue-500 hover:underline">
                  Reset to suggestion
                </button>
              )}
            </p>
          )}
        </div>
      </div>
      {!allowed && workspaceId && (
        <p role="status" className="flex items-start gap-2 rounded-xl bg-amber-500/[0.07] border border-amber-500/20 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-200">
          <AlertCircle className="w-3.5 h-3.5 mt-px shrink-0" />
          Creating a data source in this workspace needs permission to manage its data sources. Choose another workspace, or ask an admin.
        </p>
      )}
    </div>
  )
}
