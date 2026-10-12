/**
 * The name, description, icon and tags of an imported view, against what the file says.
 *
 * A new view (create or copy) starts from the file's values, with a way back to each once it's
 * changed, and a warning when the workspace already has a view by that name. An update or overwrite starts
 * from the view's CURRENT values (renaming a view because a file arrived would surprise people),
 * with a per-field switch to take the file's instead.
 */
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FileJson2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { listViews, type View } from '@/services/viewApiService'
import type { BundleViewMetadata } from '@/services/viewTransferApiService'
import type { WizardFormData } from '../ViewWizard'

type Field = 'name' | 'description' | 'icon' | 'tags'

const FIELD_LABEL: Record<Field, string> = { name: 'Name', description: 'Description', icon: 'Icon', tags: 'Tags' }

function fileValue(file: BundleViewMetadata, field: Field): string | string[] {
  if (field === 'tags') return file.tags ?? []
  if (field === 'icon') return file.icon ?? 'Layout'
  return (field === 'name' ? file.name : file.description) ?? ''
}

function currentValue(view: View, field: Field): string | string[] {
  if (field === 'tags') return view.tags ?? []
  if (field === 'icon') return view.config?.icon ?? 'Layout'
  return (field === 'name' ? view.name : view.description) ?? ''
}

function formValue(formData: WizardFormData, field: Field): string | string[] {
  return field === 'tags' ? formData.tags : formData[field]
}

function same(a: string | string[], b: string | string[]): boolean {
  return Array.isArray(a) && Array.isArray(b) ? a.join('\u0000') === b.join('\u0000') : a === b
}

function show(value: string | string[]): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : 'No tags'
  return value || 'Empty'
}

export function ImportMetadataPanel({ formData, updateFormData, file, environment, current, workspaceId }: {
  formData: WizardFormData
  updateFormData: (updates: Partial<WizardFormData>) => void
  file: BundleViewMetadata
  environment?: string | null
  /** The view being updated or overwritten; absent when creating. */
  current?: View | null
  workspaceId: string
}) {
  if (current) return <PerFieldChoice formData={formData} updateFormData={updateFormData} file={file} current={current} environment={environment} />
  return <NewViewNaming formData={formData} updateFormData={updateFormData} file={file} environment={environment} workspaceId={workspaceId} />
}

function PerFieldChoice({ formData, updateFormData, file, current, environment }: {
  formData: WizardFormData
  updateFormData: (updates: Partial<WizardFormData>) => void
  file: BundleViewMetadata
  current: View
  environment?: string | null
}) {
  const fields = (['name', 'description', 'icon', 'tags'] as Field[])
    .filter(f => !same(fileValue(file, f), currentValue(current, f)))
  if (fields.length === 0) {
    return (
      <p className="flex items-center gap-2 rounded-xl border border-glass-border px-4 py-3 text-xs text-ink-muted">
        <FileJson2 className="w-4 h-4 text-indigo-500" />
        The file’s name, description, icon and tags are the same as this view’s.
      </p>
    )
  }
  return (
    <div className="rounded-2xl border border-glass-border overflow-hidden">
      <div className="px-4 py-2.5 bg-black/[0.015] dark:bg-white/[0.02] border-b border-glass-border">
        <p className="text-xs font-bold text-ink">Where the file and this view differ</p>
        <p className="text-[11px] text-ink-muted">This view’s current details are kept unless you choose the file’s.</p>
      </div>
      <div className="divide-y divide-glass-border">
        {fields.map(field => {
          const fromFile = fileValue(file, field)
          const now = currentValue(current, field)
          const value = formValue(formData, field)
          const choice = same(value, fromFile) ? 'file' : same(value, now) ? 'current' : 'custom'
          const set = (v: string | string[]) => updateFormData({ [field]: v } as Partial<WizardFormData>)
          return (
            <div key={field} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-24 shrink-0 text-[11px] font-semibold text-ink-secondary">{FIELD_LABEL[field]}</span>
              <div className="inline-flex rounded-lg border border-glass-border p-0.5 shrink-0" role="group" aria-label={`${FIELD_LABEL[field]} to use`}>
                <button type="button" aria-pressed={choice === 'current'} onClick={() => set(now)}
                  className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold', choice === 'current' ? 'bg-black/[0.07] dark:bg-white/[0.1] text-ink' : 'text-ink-muted hover:text-ink')}>
                  Keep current
                </button>
                <button type="button" aria-pressed={choice === 'file'} onClick={() => set(fromFile)}
                  className={cn('px-2.5 py-1 rounded-md text-[11px] font-semibold', choice === 'file' ? 'bg-indigo-500 text-white' : 'text-ink-muted hover:text-ink')}>
                  Use {environment ? `${environment}’s` : 'the file’s'}
                </button>
              </div>
              <span className="text-[11px] text-ink-muted truncate min-w-0" title={show(choice === 'file' ? now : fromFile)}>
                {choice === 'custom' ? 'Edited below' : choice === 'file' ? `was “${show(now)}”` : `file says “${show(fromFile)}”`}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NewViewNaming({ formData, updateFormData, file, environment, workspaceId }: {
  formData: WizardFormData
  updateFormData: (updates: Partial<WizardFormData>) => void
  file: BundleViewMetadata
  environment?: string | null
  workspaceId: string
}) {
  const name = useDebouncedValue(formData.name.trim(), 300)
  const { data } = useQuery({
    queryKey: ['import-name-check', workspaceId, name],
    queryFn: () => listViews({ workspaceId, search: name, limit: 20 }),
    enabled: name.length > 0,
    staleTime: 30_000,
  })
  const taken = new Set((data?.items ?? []).map(v => v.name.trim().toLowerCase()))
  const duplicate = name.length > 0 && taken.has(name.toLowerCase())
  const suggestions = duplicate
    ? [environment ? `${name} (from ${environment})` : null, `${name} (imported)`, `${name} 2`]
      .filter((s): s is string => !!s && !taken.has(s.toLowerCase()))
    : []
  const renamed = formData.name !== file.name
  const changed = (['description', 'icon', 'tags'] as Field[]).filter(f => !same(formValue(formData, f), fileValue(file, f)))

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 rounded-xl border border-glass-border px-4 py-2.5">
        <FileJson2 className="w-4 h-4 text-indigo-500 shrink-0" />
        <p className="text-xs text-ink-muted flex-1 min-w-0 truncate">
          From the file: <span className="font-semibold text-ink">{file.name}</span>
          {environment ? <> · exported from {environment}</> : null}
        </p>
        {renamed && (
          <button type="button" onClick={() => updateFormData({ name: file.name })}
            className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0">
            <RotateCcw className="w-3 h-3" /> Use the file’s name
          </button>
        )}
      </div>
      {changed.length > 0 && (
        <p className="flex items-center gap-x-3 gap-y-1 flex-wrap px-1 text-[11px] text-ink-muted">
          <span>Changed from the file. Use the file’s:</span>
          {changed.map(f => (
            <button key={f} type="button" onClick={() => updateFormData({ [f]: fileValue(file, f) } as Partial<WizardFormData>)}
              className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
              <RotateCcw className="w-3 h-3" /> {FIELD_LABEL[f].toLowerCase()}
            </button>
          ))}
        </p>
      )}
      {duplicate && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] px-4 py-2.5">
          <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-xs text-amber-800 dark:text-amber-200">A view named “{name}” already exists in this workspace.</p>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {suggestions.map(s => (
                  <button key={s} type="button" onClick={() => updateFormData({ name: s })}
                    className="text-[11px] font-medium px-2 py-0.5 rounded-lg border border-amber-500/30 text-amber-800 dark:text-amber-200 hover:bg-amber-500/10">
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
