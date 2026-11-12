/**
 * ImportSettingsFields — a graph's import settings over the platform's: what its imports' rows find
 * their items by when an import names nothing else, and the replace guard's limits. Each shows the
 * graph's own value, or "Platform default (…)". A workspace admin changes them and saves only what
 * changed, sending 'inherit' for one taken from the platform again; everyone else reads them. Below,
 * the properties its imports match by, and how far each one's index is caught up. The server holds
 * the rules (`services.import_settings`).
 */
import { useId, useState } from 'react'
import { Loader2, RotateCcw, Save } from 'lucide-react'
import { useAppNotifications } from '@/components/ui/notifications'
import type { ImportSettings, ImportSettingsChange, ImportSettingsValues } from '@/services/importExportApiService'
import { formatIdentifier, identifierLabel, MATCH_KINDS, parseIdentifier, type MatchKind } from './identifier'

type Limit = Exclude<keyof ImportSettingsValues, 'identifier'>

const LIMITS: Array<{ key: Limit; label: string; percent: boolean }> = [
  { key: 'replaceMinLive', label: 'The replace guard judges a scope of at least (items)', percent: false },
  { key: 'replaceDeleteFraction', label: 'It refuses a replace that deletes at least (%)', percent: true },
  { key: 'replaceCreateFraction', label: '…and creates at least this many again (%)', percent: true },
  { key: 'replaceMinMatchFraction', label: 'A replace stops early when its first rows find under (%)', percent: true },
]

const shown = (value: number, percent: boolean) =>
  percent ? `${Math.round(value * 1000) / 10}` : value.toLocaleString()

export function ImportSettingsFields({ settings, canEdit, onSave }: {
  settings: ImportSettings
  canEdit: boolean
  onSave: (change: ImportSettingsChange) => Promise<unknown>
}) {
  const id = useId()
  const { notify } = useAppNotifications()
  const [change, setChange] = useState<ImportSettingsChange>({})
  const [saving, setSaving] = useState(false)
  const editable = canEdit && !settings.followsParent
  const own = settings.overrides

  const set = <K extends keyof ImportSettingsValues>(key: K, to: ImportSettingsValues[K] | 'inherit') =>
    setChange((c) => {
      const next = { ...c, [key]: to }
      if (to === (own[key] ?? 'inherit')) delete next[key]
      return next
    })

  const identifier = change.identifier ?? own.identifier ?? 'inherit'
  const kind: MatchKind | 'inherit' = identifier === 'inherit' ? 'inherit' : parseIdentifier(identifier).kind
  const propName = kind === 'prop' ? parseIdentifier(identifier).name : ''
  const unnamed = kind === 'prop' && !propName.trim()

  const save = async () => {
    setSaving(true)
    try {
      await onSave(change)
      setChange({})
      notify('success', 'Import settings saved')
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Could not save the import settings')
    } finally {
      setSaving(false)
    }
  }

  const control = 'max-w-full px-2 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border text-[12px] text-ink focus:outline-none focus:border-accent-lineage/50 disabled:opacity-60 disabled:cursor-not-allowed'
  return (
    <div>
      <div className="divide-y divide-glass-border">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5">
          <div className="min-w-0">
            <label htmlFor={`${id}-identifier`} className="block text-[12px] font-medium text-ink">Match existing items by</label>
            <p className="text-[11px] text-ink-muted mt-0.5 leading-snug">
              When an import names nothing else. An item’s id never changes, whichever it is.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <select id={`${id}-identifier`} value={kind} disabled={!editable || saving} className={control}
              onChange={(e) => {
                const to = e.target.value as MatchKind | 'inherit'
                set('identifier', to === 'inherit' ? 'inherit' : formatIdentifier({ kind: to, name: propName }))
              }}>
              <option value="inherit">Platform default ({identifierLabel(settings.platform.identifier)})</option>
              {MATCH_KINDS.map((m) => <option key={m.kind} value={m.kind}>{m.label}</option>)}
            </select>
            {kind === 'prop' && (
              <input aria-label="Property name" placeholder="external_id" value={propName}
                disabled={!editable || saving} className={`${control} w-32 font-mono`}
                onChange={(e) => set('identifier', `prop.${e.target.value}`)} />
            )}
          </div>
        </div>
        {LIMITS.map((f) => {
          const value = change[f.key] ?? own[f.key]
          return (
            <div key={f.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5">
              <label htmlFor={`${id}-${f.key}`} className="text-[12px] font-medium text-ink min-w-0">{f.label}</label>
              <input id={`${id}-${f.key}`} type="number" min={0} max={f.percent ? 100 : undefined}
                step={f.percent ? 1 : 100} disabled={!editable || saving} className={`${control} w-36 tabular-nums`}
                placeholder={`${shown(settings.platform[f.key], f.percent)} (platform)`}
                value={value == null || value === 'inherit' ? '' : f.percent ? shown(value, true) : String(value)}
                onChange={(e) => {
                  const raw = e.target.value
                  if (raw === '') return set(f.key, 'inherit')
                  const n = Number(raw)
                  if (Number.isFinite(n)) set(f.key, f.percent ? n / 100 : Math.round(n))
                }} />
            </div>
          )
        })}
      </div>
      {!settings.replaceGuard && (
        <p className="text-[11px] text-ink-muted mt-1">
          The replace guard is off on this platform, so no replace is refused; these limits apply once it is on.
        </p>
      )}
      <div className="mt-3">
        <p className="text-[12px] font-medium text-ink">
          Properties imports match by
          <span className="font-normal text-ink-muted"> · {settings.matchingProperties.length} of {settings.maxMatchingProperties}</span>
        </p>
        {settings.matchingProperties.length === 0 ? (
          <p className="text-[11px] text-ink-muted mt-0.5">
            None yet. The first import that matches by a property indexes it, reading every item once.
          </p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {settings.matchingProperties.map((p) => (
              <li key={p.name} className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono text-ink truncate">{p.name}</span>
                <span className="text-ink-muted flex-shrink-0">
                  {p.status === 'building' ? 'Indexing…' : p.current ? 'Up to date' : 'Catches up on the next import'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {settings.effective.sources.identifier === 'fork' && (
        <p className="text-[11px] text-ink-muted mt-2">
          A fork can’t match by a property yet, so its imports match by Entity ID.
        </p>
      )}
      {settings.followsParent
        ? <p className="text-[11px] text-ink-muted mt-2">A fork’s import settings are its parent’s: change them there.</p>
        : !canEdit && <p className="text-[11px] text-ink-muted mt-2">Only a workspace admin can change these.</p>}
      {editable && Object.keys(change).length > 0 && (
        <div className="flex items-center justify-end gap-2 mt-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20">
          {unnamed && <p className="mr-auto text-[11px] text-amber-700 dark:text-amber-400">Name the property.</p>}
          <button onClick={() => setChange({})} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50">
            <RotateCcw className="w-3 h-3" /> Discard
          </button>
          <button onClick={() => void save()} disabled={saving || unnamed}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
