import { Trash2, AlertTriangle, Shield, Lock, Info } from 'lucide-react'
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

  function updateField(field: 'name' | 'description', value: string) {
    onUpdateDetails({
      name: field === 'name' ? value : name,
      description: field === 'description' ? value : description,
      // The policy is not user-editable: only 'reject' is implemented server-side
      // (breaking publishes are blocked; admins can force-publish from the
      // publish dialog). Pass the current value through unchanged.
      evolutionPolicy,
    })
  }

  // 'deprecate'/'migrate' were once selectable but were never implemented —
  // their only effect was silently disabling the breaking-change block.
  const hasUnsupportedPolicy = evolutionPolicy !== 'reject'

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

      {/* Breaking-change protection — informational (the only implemented
          policy is 'reject'; the escape hatch is force-publish, admin-gated,
          in the publish dialog). */}
      <div className="rounded-xl border border-glass-border bg-canvas-elevated/50 p-5">
        <h3 className="text-sm font-semibold text-ink mb-1 flex items-center gap-2">
          <Shield className="w-4 h-4 text-green-500" />
          Breaking-Change Protection
        </h3>
        <p className="text-[11px] text-ink-muted mb-3">
          Publishing a version that removes types still present in assigned graphs is blocked,
          so existing views never break silently. Administrators can override with
          &ldquo;Force publish&rdquo; in the publish dialog after reviewing the impact.
        </p>
        {hasUnsupportedPolicy && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-500/[0.08] border border-amber-500/20">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-600 dark:text-amber-400">
              This layer has the legacy policy <span className="font-mono font-semibold">{evolutionPolicy}</span>,
              which was never implemented — it is treated as allowing breaking publishes without
              any deprecation or migration behavior. Recommended: leave breaking-change
              protection on by ignoring this setting; it will not block your publishes.
            </p>
          </div>
        )}
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
