import { X, AlertTriangle, Plus, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse, OntologyImpactResponse } from '@/services/ontologyDefinitionService'

interface PublishConfirmDialogProps {
  ontology: OntologyDefinitionResponse
  impact: OntologyImpactResponse
  onConfirm: () => void
  onClose: () => void
}

function TypeDiffList({ types, variant }: { types: string[]; variant: 'added' | 'removed' }) {
  if (types.length === 0) return null

  const isAdded = variant === 'added'
  return (
    <div className="flex flex-wrap gap-1.5">
      {types.map(t => (
        <span
          key={t}
          className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium',
            isAdded
              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-400'
              : 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-400'
          )}
        >
          {isAdded ? <Plus className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
          {t}
        </span>
      ))}
    </div>
  )
}

const POLICY_LABELS: Record<string, string> = {
  reject: 'Reject',
  deprecate: 'Deprecate',
  migrate: 'Migrate',
}

export function PublishConfirmDialog({
  ontology,
  impact,
  onConfirm,
  onClose,
}: PublishConfirmDialogProps) {
  const hasChanges =
    impact.addedEntityTypes.length > 0 ||
    impact.removedEntityTypes.length > 0 ||
    impact.addedRelationshipTypes.length > 0 ||
    impact.removedRelationshipTypes.length > 0

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-lg font-bold text-ink">
            Publish &ldquo;{ontology.name}&rdquo; v{ontology.version}?
          </h3>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-sm text-ink-muted mb-5">
          Publishing is irreversible. This ontology will become active for all assigned data sources.
        </p>

        {/* Impact section */}
        {hasChanges && (
          <div className="space-y-3 mb-5">
            {impact.addedEntityTypes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Added Entity Types</p>
                <TypeDiffList types={impact.addedEntityTypes} variant="added" />
              </div>
            )}
            {impact.removedEntityTypes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Removed Entity Types</p>
                <TypeDiffList types={impact.removedEntityTypes} variant="removed" />
              </div>
            )}
            {impact.addedRelationshipTypes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Added Relationship Types</p>
                <TypeDiffList types={impact.addedRelationshipTypes} variant="added" />
              </div>
            )}
            {impact.removedRelationshipTypes.length > 0 && (
              <div>
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-1.5">Removed Relationship Types</p>
                <TypeDiffList types={impact.removedRelationshipTypes} variant="removed" />
              </div>
            )}
          </div>
        )}

        {!hasChanges && (
          <p className="text-sm text-ink-muted mb-5">No type changes detected compared to the previous published version.</p>
        )}

        {/* Blocked warning */}
        {!impact.allowed && impact.reason && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50 mb-5">
            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-red-700 dark:text-red-400">{impact.reason}</p>
          </div>
        )}

        {/* Evolution policy badge */}
        <div className="flex items-center gap-2 mb-5">
          <span className="text-xs text-ink-muted">Evolution policy:</span>
          <span className="inline-flex px-2 py-0.5 rounded-md bg-black/5 dark:bg-white/5 text-xs font-semibold text-ink">
            {POLICY_LABELS[impact.evolutionPolicy] ?? impact.evolutionPolicy}
          </span>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-3">
          <button
            onClick={onClose}
            autoFocus
            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!impact.allowed}
            className="px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Publish
          </button>
        </div>
      </div>
    </div>
  )
}
