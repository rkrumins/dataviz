import { useState } from 'react'
import { X, Loader2, Check, Settings, Shield, ShieldOff, GitMerge } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { OntologyStatusBadge } from '../OntologyStatusBadge'

interface EditDetailsDialogProps {
  ontology: OntologyDefinitionResponse
  onClose: () => void
  onSave: (updates: { name: string; description: string; evolutionPolicy: string }) => void
}

export function EditDetailsDialog({
  ontology,
  onClose,
  onSave,
}: EditDetailsDialogProps) {
  const [name, setName] = useState(ontology.name)
  const [description, setDescription] = useState(ontology.description ?? '')
  const [evolutionPolicy, setEvolutionPolicy] = useState(ontology.evolutionPolicy ?? 'reject')
  const [isSaving, setIsSaving] = useState(false)

  const policyOptions = [
    {
      value: 'reject',
      label: 'Reject',
      hint: 'Block publishing if existing data would break (safest)',
      icon: Shield,
      accent: 'text-green-600 dark:text-green-400',
      accentBg: 'bg-green-50 dark:bg-green-950/30',
    },
    {
      value: 'deprecate',
      label: 'Deprecate',
      hint: 'Mark removed types as deprecated; continue serving them',
      icon: ShieldOff,
      accent: 'text-amber-600 dark:text-amber-400',
      accentBg: 'bg-amber-50 dark:bg-amber-950/30',
    },
    {
      value: 'migrate',
      label: 'Migrate',
      hint: 'Auto-remap types according to a migration manifest',
      icon: GitMerge,
      accent: 'text-indigo-600 dark:text-indigo-400',
      accentBg: 'bg-indigo-50 dark:bg-indigo-950/30',
    },
  ]

  async function handleSave() {
    if (!name.trim()) return
    setIsSaving(true)
    await onSave({ name: name.trim(), description, evolutionPolicy })
    setIsSaving(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        {/* Header */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center">
                <Settings className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Edit Details</h3>
                <p className="text-[11px] text-ink-muted mt-0.5 flex items-center gap-1.5">
                  v{ontology.version} <span className="opacity-30">|</span> <OntologyStatusBadge ontology={ontology} size="xs" />
                </p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
              placeholder="Semantic layer name..."
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              rows={3}
              className="w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted/60 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all resize-none"
              placeholder="Describe the purpose and scope of this semantic layer..."
            />
          </div>

          {/* Evolution Policy — visual radio cards */}
          {!ontology.isPublished && (
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Evolution Policy</label>
            <p className="text-[11px] text-ink-muted mb-2.5">Controls what happens when published with breaking changes.</p>
            <div className="space-y-2">
              {policyOptions.map(opt => {
                const Icon = opt.icon
                const isSelected = evolutionPolicy === opt.value
                return (
                  <button
                    key={opt.value}
                    onClick={() => setEvolutionPolicy(opt.value)}
                    className={cn(
                      'w-full text-left px-3.5 py-3 rounded-xl border-2 transition-all',
                      isSelected
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                        : 'border-glass-border hover:border-glass-border-hover'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                        isSelected ? opt.accentBg : 'bg-black/5 dark:bg-white/5'
                      )}>
                        <Icon className={cn('w-4 h-4', isSelected ? opt.accent : 'text-ink-muted')} />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-semibold text-ink">{opt.label}</span>
                          {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-indigo-500" />}
                        </div>
                        <p className="text-[11px] text-ink-muted mt-0.5">{opt.hint}</p>
                      </div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
          )}
        </div>

        {/* Footer actions */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim() || isSaving}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
          >
            {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
            {isSaving ? 'Saving...' : 'Save Details'}
          </button>
        </div>
      </div>
    </div>
  )
}
