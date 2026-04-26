/**
 * ImportDialog — Shows import results, validation errors, or a "no changes" notice.
 * Also handles the import mode selection (new vs. into current).
 */
import { useState } from 'react'
import { X, Upload, FileJson, AlertTriangle, CheckCircle2, Info, Loader2, ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { OntologyImportResponse } from '@/services/ontologyDefinitionService'

interface ImportDialogProps {
  /** The parsed JSON from the file. */
  importData: Record<string, unknown>
  /** Currently selected ontology, if any. */
  currentOntology: OntologyDefinitionResponse | null
  onClose: () => void
  onImportNew: (data: Record<string, unknown>) => Promise<OntologyImportResponse>
  onImportInto: (id: string, data: Record<string, unknown>) => Promise<OntologyImportResponse>
  onSuccess: (result: OntologyImportResponse) => void
}

type ImportMode = 'new' | 'into'

const REQUIRED_FIELDS = ['name', 'entityTypeDefinitions', 'relationshipTypeDefinitions'] as const

function validateImportData(data: Record<string, unknown>): string[] {
  const errors: string[] = []

  // Must be an object
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return ['Import file must be a JSON object']
  }

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (!(field in data)) {
      errors.push(`Missing required field: "${field}"`)
    }
  }

  // Name must be a non-empty string
  if ('name' in data && (typeof data.name !== 'string' || !data.name.trim())) {
    errors.push('"name" must be a non-empty string')
  }

  // Type checks for definition fields
  if ('entityTypeDefinitions' in data && typeof data.entityTypeDefinitions !== 'object') {
    errors.push('"entityTypeDefinitions" must be an object')
  }
  if ('relationshipTypeDefinitions' in data && typeof data.relationshipTypeDefinitions !== 'object') {
    errors.push('"relationshipTypeDefinitions" must be an object')
  }

  // Optional array fields
  for (const field of ['containmentEdgeTypes', 'lineageEdgeTypes', 'rootEntityTypes'] as const) {
    if (field in data && !Array.isArray(data[field])) {
      errors.push(`"${field}" must be an array`)
    }
  }

  // Optional object fields
  for (const field of ['edgeTypeMetadata', 'entityTypeHierarchy'] as const) {
    if (field in data && (typeof data[field] !== 'object' || Array.isArray(data[field]))) {
      errors.push(`"${field}" must be an object`)
    }
  }

  // Evolution policy check
  if ('evolutionPolicy' in data) {
    const policy = data.evolutionPolicy
    if (typeof policy !== 'string' || !['reject', 'deprecate', 'migrate'].includes(policy)) {
      errors.push('"evolutionPolicy" must be one of: reject, deprecate, migrate')
    }
  }

  return errors
}

export function ImportDialog({
  importData,
  currentOntology,
  onClose,
  onImportNew,
  onImportInto,
  onSuccess,
}: ImportDialogProps) {
  const [mode, setMode] = useState<ImportMode>(currentOntology ? 'into' : 'new')
  const [isImporting, setIsImporting] = useState(false)
  const [result, setResult] = useState<OntologyImportResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const validationErrors = validateImportData(importData)
  const isValid = validationErrors.length === 0

  const importName = typeof importData.name === 'string' ? importData.name : 'Unknown'
  const entityCount = typeof importData.entityTypeDefinitions === 'object' && importData.entityTypeDefinitions
    ? Object.keys(importData.entityTypeDefinitions).length
    : 0
  const relCount = typeof importData.relationshipTypeDefinitions === 'object' && importData.relationshipTypeDefinitions
    ? Object.keys(importData.relationshipTypeDefinitions).length
    : 0

  async function handleImport() {
    setIsImporting(true)
    setError(null)
    try {
      let res: OntologyImportResponse
      if (mode === 'into' && currentOntology) {
        res = await onImportInto(currentOntology.id, importData)
      } else {
        res = await onImportNew(importData)
      }
      setResult(res)
      if (res.status !== 'no_changes') {
        onSuccess(res)
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Import failed'
      // Try to extract detail from API error
      const detailMatch = msg.match(/"detail"\s*:\s*"([^"]+)"/)
      setError(detailMatch ? detailMatch[1] : msg)
    } finally {
      setIsImporting(false)
    }
  }

  // ── Result view ──────────────────────────────────────────────────
  if (result) {
    const isNoChanges = result.status === 'no_changes'
    const Icon = isNoChanges ? Info : CheckCircle2
    const accent = isNoChanges
      ? 'text-blue-500 bg-blue-50 dark:bg-blue-950/30'
      : 'text-emerald-500 bg-emerald-50 dark:bg-emerald-950/30'

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-md mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
          <div className="px-6 pt-6 pb-4">
            <div className="flex items-start gap-4">
              <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0', accent)}>
                <Icon className="w-5 h-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-ink">
                  {isNoChanges ? 'No Changes Detected' : 'Import Successful'}
                </h3>
                <p className="text-sm text-ink-muted mt-1">{result.summary}</p>
              </div>
            </div>
          </div>

          {/* Show change details if available */}
          {result.changes && !isNoChanges && (
            <div className="mx-6 mb-4 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4 space-y-1.5">
              {result.changes.addedEntityTypes && result.changes.addedEntityTypes.length > 0 && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  + {result.changes.addedEntityTypes.length} entity type(s): {result.changes.addedEntityTypes.join(', ')}
                </p>
              )}
              {result.changes.removedEntityTypes && result.changes.removedEntityTypes.length > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  - {result.changes.removedEntityTypes.length} entity type(s): {result.changes.removedEntityTypes.join(', ')}
                </p>
              )}
              {result.changes.addedRelationshipTypes && result.changes.addedRelationshipTypes.length > 0 && (
                <p className="text-xs text-emerald-600 dark:text-emerald-400">
                  + {result.changes.addedRelationshipTypes.length} relationship(s): {result.changes.addedRelationshipTypes.join(', ')}
                </p>
              )}
              {result.changes.removedRelationshipTypes && result.changes.removedRelationshipTypes.length > 0 && (
                <p className="text-xs text-red-600 dark:text-red-400">
                  - {result.changes.removedRelationshipTypes.length} relationship(s): {result.changes.removedRelationshipTypes.join(', ')}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
            <button
              onClick={onClose}
              className="px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors shadow-sm"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Pre-import view (validation + mode selection) ────────────────
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-md mx-4 animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
        {/* Header */}
        <div className="border-b border-glass-border/50 px-6 pt-6 pb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-indigo-50 dark:bg-indigo-950/30 flex items-center justify-center">
                <Upload className="w-5 h-5 text-indigo-500" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-ink">Import Semantic Layer</h3>
                <p className="text-[11px] text-ink-muted mt-0.5">Review and confirm the import</p>
              </div>
            </div>
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* File summary */}
          <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-4">
            <div className="flex items-center gap-3">
              <FileJson className="w-8 h-8 text-indigo-400 flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">{importName}</p>
                <p className="text-[11px] text-ink-muted mt-0.5">
                  {entityCount} entity types · {relCount} relationships
                  {importData.version ? ` · v${importData.version}` : ''}
                </p>
              </div>
            </div>
          </div>

          {/* Validation errors */}
          {!isValid && (
            <div className="rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-4">
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-500" />
                <p className="text-xs font-semibold text-red-700 dark:text-red-400">Validation Failed</p>
              </div>
              <ul className="space-y-1">
                {validationErrors.map((err, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-red-600 dark:text-red-400">
                    <div className="w-1 h-1 rounded-full bg-red-500 mt-1.5 flex-shrink-0" />
                    {err}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Import mode selection */}
          {isValid && (
            <div>
              <label className="block text-xs font-medium text-ink-secondary mb-2">Import Target</label>
              <div className="space-y-2">
                {/* Import as new */}
                <button
                  onClick={() => setMode('new')}
                  className={cn(
                    'w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
                    mode === 'new'
                      ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                      : 'border-glass-border hover:border-glass-border-hover'
                  )}
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                      mode === 'new' ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5'
                    )}>
                      <FileJson className={cn('w-4 h-4', mode === 'new' ? 'text-indigo-500' : 'text-ink-muted')} />
                    </div>
                    <div className="flex-1">
                      <span className="text-sm font-semibold text-ink">Create New Draft</span>
                      <p className="text-[11px] text-ink-muted mt-0.5">Import as a brand new semantic layer</p>
                    </div>
                  </div>
                </button>

                {/* Import into current */}
                {currentOntology && (
                  <button
                    onClick={() => setMode('into')}
                    className={cn(
                      'w-full text-left px-3.5 py-3 rounded-xl border-2 transition-colors duration-150',
                      mode === 'into'
                        ? 'border-indigo-500 bg-indigo-50/50 dark:bg-indigo-950/20 shadow-sm shadow-indigo-500/10'
                        : 'border-glass-border hover:border-glass-border-hover'
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
                        mode === 'into' ? 'bg-indigo-100 dark:bg-indigo-900/50' : 'bg-black/5 dark:bg-white/5'
                      )}>
                        <ArrowRight className={cn('w-4 h-4', mode === 'into' ? 'text-indigo-500' : 'text-ink-muted')} />
                      </div>
                      <div className="flex-1">
                        <span className="text-sm font-semibold text-ink">
                          Import into "{currentOntology.name}"
                        </span>
                        <p className="text-[11px] text-ink-muted mt-0.5">
                          {currentOntology.isPublished
                            ? 'Published — will create a new draft version'
                            : `Draft v${currentOntology.version} — will update in-place`}
                        </p>
                      </div>
                    </div>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Error from API */}
          {error && (
            <div className="rounded-xl border border-red-200 dark:border-red-800/50 bg-red-50/50 dark:bg-red-950/20 p-3">
              <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-glass-border/50 bg-black/[0.01] dark:bg-white/[0.01]">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleImport}
            disabled={!isValid || isImporting}
            className="flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
          >
            {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {isImporting ? 'Importing...' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  )
}
