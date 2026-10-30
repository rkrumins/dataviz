/**
 * DraftsPolicyFields — one level's drafts and reviews settings: a workspace's, or a data source's
 * over its workspace's. Each shows the level's own value, or what it takes from above, named:
 * "Default (Public)" for a workspace, "Use the workspace’s setting (Public)" for a data source. A
 * workspace admin changes them and saves only what changed, sending 'inherit' for a setting taken
 * from above again; everyone else reads them. The server holds the rules (`drafts_policy`).
 */
import { useId, useState } from 'react'
import { Loader2, RotateCcw, Save } from 'lucide-react'
import { useAppNotifications } from '@/components/ui/notifications'
import type { DraftsPolicyChange, DraftsPolicySettings } from '@/services/versioningApiService'

type Field = keyof DraftsPolicySettings
type Value = NonNullable<DraftsPolicySettings[Field]>
type Choice = Value | 'inherit'

/** What holds where neither a data source nor its workspace sets a field (`drafts_policy.FIELDS`). */
const BUILT_IN: Record<Field, Value> = { defaultVisibility: 'public', levels: 'any', selfApproval: true, selfMerge: true }

const YES_NO: Array<[Value, string]> = [[true, 'Yes'], [false, 'No']]

const FIELDS: Array<{ key: Field; label: string; options: Array<[Value, string]> }> = [
  { key: 'defaultVisibility', label: 'New drafts start', options: [['public', 'Public'], ['private', 'Private']] },
  { key: 'levels', label: 'Drafts may be',
    options: [['any', 'Public or private'], ['public_only', 'Public only'], ['private_only', 'Private only']] },
  { key: 'selfApproval', label: 'Whoever opens a review may approve it', options: YES_NO },
  { key: 'selfMerge', label: 'Whoever opens a review may merge it', options: YES_NO },
]

export function DraftsPolicyFields({ own, workspace, canEdit, onSave }: {
  /** This level's own settings: null where it sets none. */
  own: DraftsPolicySettings
  /** A data source's: its workspace's own settings, which it takes where it sets none. */
  workspace?: DraftsPolicySettings
  canEdit: boolean
  onSave: (change: DraftsPolicyChange) => Promise<unknown>
}) {
  const id = useId()
  const { notify } = useAppNotifications()
  // Only the fields changed here, each to a value or back to what it takes from above.
  const [change, setChange] = useState<Partial<Record<Field, Choice>>>({})
  const [saving, setSaving] = useState(false)

  const picked = (key: Field): Choice => change[key] ?? own[key] ?? 'inherit'
  const above = (key: Field): Value => workspace?.[key] ?? BUILT_IN[key]
  const holds = (key: Field): Value => { const p = picked(key); return p === 'inherit' ? above(key) : p }

  const pick = (f: (typeof FIELDS)[number], raw: string) => {
    const to = raw === 'inherit' ? 'inherit' : f.options.find(([v]) => String(v) === raw)![0]
    setChange((c) => {
      const next = { ...c, [f.key]: to }
      if (to === (own[f.key] ?? 'inherit')) delete next[f.key]
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await onSave(change as DraftsPolicyChange)
      setChange({})
      notify('success', 'Drafts and reviews settings saved')
    } catch (e) {
      notify('error', e instanceof Error ? e.message : 'Could not save the drafts and reviews settings')
    } finally {
      setSaving(false)
    }
  }

  // A level that is the only one allowed is also where new drafts start.
  const levels = String(holds('levels'))
  const only = levels === 'any' ? null : levels.replace('_only', '')
  const hints: Partial<Record<Field, string | false>> = {
    defaultVisibility: only !== null && `Drafts may only be ${only}, so new drafts start ${only}.`,
    levels: 'Turning private drafts off leaves existing private drafts as they are.',
    selfMerge: holds('selfMerge') === false && 'Drafts are then published only through a review someone else merges.',
  }

  return (
    <div>
      <div className="divide-y divide-glass-border">
        {FIELDS.map((f) => {
          const name = (v: Value) => f.options.find(([o]) => o === v)?.[1] ?? String(v)
          return (
            <div key={f.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 py-2.5">
              <div className="min-w-0">
                <label htmlFor={`${id}-${f.key}`} className="block text-[12px] font-medium text-ink">{f.label}</label>
                {hints[f.key] && <p className="text-[11px] text-ink-muted mt-0.5 leading-snug">{hints[f.key]}</p>}
              </div>
              <select
                id={`${id}-${f.key}`}
                value={String(picked(f.key))}
                disabled={!canEdit || saving}
                onChange={(e) => pick(f, e.target.value)}
                className="max-w-full px-2 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border text-[12px] text-ink focus:outline-none focus:border-accent-lineage/50 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <option value="inherit">
                  {workspace ? `Use the workspace’s setting (${name(above(f.key))})` : `Default (${name(above(f.key))})`}
                </option>
                {f.options.map(([v, label]) => <option key={String(v)} value={String(v)}>{label}</option>)}
              </select>
            </div>
          )
        })}
      </div>
      {!canEdit && <p className="text-[11px] text-ink-muted mt-1">Only a workspace admin can change these.</p>}
      {canEdit && Object.keys(change).length > 0 && (
        <div className="flex items-center justify-end gap-2 mt-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20">
          <button
            onClick={() => setChange({})}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
          >
            <RotateCcw className="w-3 h-3" /> Discard
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}
    </div>
  )
}
