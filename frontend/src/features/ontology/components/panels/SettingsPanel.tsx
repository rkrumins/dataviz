import { Trash2, AlertTriangle, Shield, Lock, Info, ShieldOff, GitMerge, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { OntologyStatusBadge } from '../OntologyStatusBadge'
import { formatDate } from '../../lib/ontology-parsers'
import { EducationalCallout } from '../EducationalCallout'

interface SettingsPanelProps {
  ontology: OntologyDefinitionResponse
  /** Current working values (staged, survives tab switches). Null = no edits yet. */
  workingDetails: { name: string; description: string; evolutionPolicy: string } | null
  /** Called when user changes any field — stages the change. */
  onUpdateDetails: (updates: { name: string; description: string; evolutionPolicy: string }) => void
  onDelete: () => void
  assignmentCount: number
}

export function SettingsPanel({ ontology, workingDetails, onUpdateDetails, onDelete, assignmentCount }: SettingsPanelProps) {
  const isLocked = ontology.isSystem || ontology.isPublished

  // Use working details if available, otherwise server state
  const name = workingDetails?.name ?? ontology.name
  const description = workingDetails?.description ?? (ontology.description ?? '')
  const evolutionPolicy = workingDetails?.evolutionPolicy ?? (ontology.evolutionPolicy ?? 'reject')

  function updateField(field: 'name' | 'description' | 'evolutionPolicy', value: string) {
    onUpdateDetails({
      name: field === 'name' ? value : name,
      description: field === 'description' ? value : description,
      evolutionPolicy: field === 'evolutionPolicy' ? value : evolutionPolicy,
    })
  }

  const policyOptions = [
    {
      value: 'reject',
      label: 'Reject',
      hint: 'Block publishing if existing data would break (safest)',
      icon: Shield,
      accent: 'text-green-600 dark:text-green-400 border-green-300 dark:border-green-700 bg-green-50/50 dark:bg-green-950/20',
      accentSelected: 'border-green-500 bg-green-50 dark:bg-green-950/30 ring-1 ring-green-500/20',
    },
    {
      value: 'deprecate',
      label: 'Deprecate',
      hint: 'Mark removed types as deprecated; continue serving them',
      icon: ShieldOff,
      accent: 'text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-700 bg-amber-50/50 dark:bg-amber-950/20',
      accentSelected: 'border-amber-500 bg-amber-50 dark:bg-amber-950/30 ring-1 ring-amber-500/20',
    },
    {
      value: 'migrate',
      label: 'Migrate',
      hint: 'Auto-remap types according to a migration manifest',
      icon: GitMerge,
      accent: 'text-indigo-600 dark:text-indigo-400 border-indigo-300 dark:border-indigo-700 bg-indigo-50/50 dark:bg-indigo-950/20',
      accentSelected: 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30 ring-1 ring-indigo-500/20',
    },
  ]

  return (
    <div className="space-y-8 max-w-2xl">
      <EducationalCallout
        id="edu-publish-draft"
        title="Draft vs. Published"
        description="Draft ontologies can be freely edited and only affect data sources when explicitly assigned. Publishing locks the ontology, creating an immutable version that serves as a stable contract. To make changes after publishing, create a new version."
        variant="tip"
      />

      {/* Metadata Section */}
      <div className="rounded-xl border border-glass-border bg-canvas-elevated/50 p-5">
        <h3 className="text-sm font-semibold text-ink mb-4 flex items-center gap-2">
          <Info className="w-4 h-4 text-indigo-500" />
          Metadata
        </h3>

        <div className="space-y-4">
          {/* ID (read-only) */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">ID</label>
            <div className="px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink-muted font-mono select-all">
              {ontology.id}
            </div>
          </div>

          {/* Schema ID (read-only) */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Schema ID</label>
            <div className="px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink-muted font-mono select-all">
              {ontology.schemaId || ontology.id}
            </div>
            <p className="text-[11px] text-ink-muted mt-1">Stable identifier shared across all versions of this semantic layer</p>
          </div>

          {/* Name */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Name</label>
            {isLocked ? (
              <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink">
                <Lock className="w-3 h-3 text-ink-muted" />
                {ontology.name}
              </div>
            ) : (
              <input
                type="text"
                value={name}
                onChange={e => updateField('name', e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all"
                placeholder="Semantic layer name..."
              />
            )}
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-ink-secondary mb-1.5">Description</label>
            {isLocked ? (
              <div className="px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink min-h-[60px]">
                {ontology.description || <span className="text-ink-muted italic">No description</span>}
              </div>
            ) : (
              <textarea
                value={description}
                onChange={e => updateField('description', e.target.value)}
                rows={3}
                className="w-full px-3.5 py-2.5 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/40 transition-all resize-none"
                placeholder="Describe the purpose and scope of this semantic layer..."
              />
            )}
          </div>

          {/* Metadata info strip */}
          <div className="flex items-center gap-4 text-[11px] text-ink-muted pt-3 border-t border-glass-border/50">
            <span>Version {ontology.version}</span>
            <span className="opacity-30">|</span>
            <span>Created {formatDate(ontology.createdAt)}</span>
            <span className="opacity-30">|</span>
            <span>Updated {formatDate(ontology.updatedAt)}</span>
            <OntologyStatusBadge ontology={ontology} size="xs" />
          </div>
        </div>
      </div>

      {/* Evolution Policy — visual radio cards */}
      <div className="rounded-xl border border-glass-border bg-canvas-elevated/50 p-5">
        <h3 className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <RotateCcw className="w-4 h-4 text-indigo-500" />
          Evolution Policy
        </h3>
        <p className="text-[11px] text-ink-muted mb-4">Controls what happens when this semantic layer is published with breaking changes.</p>

        <div className="space-y-2">
          {policyOptions.map(opt => {
            const Icon = opt.icon
            const isSelected = evolutionPolicy === opt.value
            return (
              <button
                key={opt.value}
                onClick={() => !isLocked && updateField('evolutionPolicy', opt.value)}
                disabled={isLocked}
                className={cn(
                  'w-full text-left px-4 py-3.5 rounded-xl border-2 transition-all',
                  isLocked && 'opacity-60 cursor-not-allowed',
                  isSelected ? opt.accentSelected : 'border-glass-border hover:border-glass-border-hover'
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0',
                    isSelected ? opt.accent : 'bg-black/5 dark:bg-white/5'
                  )}>
                    <Icon className={cn('w-4 h-4', isSelected ? '' : 'text-ink-muted')} />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-ink">{opt.label}</span>
                      {isSelected && (
                        <div className="w-2 h-2 rounded-full bg-indigo-500" />
                      )}
                    </div>
                    <p className="text-[11px] text-ink-muted mt-0.5">{opt.hint}</p>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Note about saving */}
      {workingDetails && (
        <p className="text-xs text-ink-muted/60 italic">
          Changes are staged — use &ldquo;Save All&rdquo; in the header to persist.
        </p>
      )}

      {/* Danger Zone */}
      {!ontology.isSystem && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.03] dark:bg-red-500/[0.03] p-5">
          <h3 className="text-sm font-semibold text-red-600 dark:text-red-400 mb-2 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4" />
            Danger Zone
          </h3>
          <p className="text-xs text-ink-muted mb-4 leading-relaxed">
            Deleting this semantic layer will remove it from all listings.
            {' '}You can recover it shortly after deletion via the undo action.
            {assignmentCount > 0 && (
              <span className="block mt-1 text-red-600/80 dark:text-red-400/80">
                This semantic layer is assigned to {assignmentCount} data source(s) — unassign them first.
              </span>
            )}
          </p>
          <button
            onClick={onDelete}
            disabled={assignmentCount > 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed text-red-600 border border-red-200 dark:border-red-800 hover:bg-red-50 dark:hover:bg-red-950/30"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete Semantic Layer
          </button>
        </div>
      )}
    </div>
  )
}
