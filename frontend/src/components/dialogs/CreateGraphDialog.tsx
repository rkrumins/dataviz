/**
 * CreateGraphDialog — authored-graph create on-ramp with three modes.
 *
 * - Blank canvas (schemaless)  → ontology_id=null, schema_mode='schemaless'.
 * - Simple lineage             → ontology_id=BASIC_LINEAGE_ONTOLOGY_ID,
 *                                 schema_mode='strict'. The seeded
 *                                 "Basic Lineage" ontology is the
 *                                 contract; no picker is shown.
 * - Strict / pick ontology     → ontology_id from the published-ontology
 *                                 dropdown, schema_mode='strict'.
 *
 * Pure presentational + local state; the host wires it to its launcher
 * surface. Submit calls the typed `createGraph()` service so
 * structured backend errors (OntologyMissingError, OntologyRequiredError)
 * surface as inline validation, not raw 422 strings.
 */
import React, { useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { GitBranch, Layers, Sparkles, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { useOntologies } from '@/features/ontology/hooks/useOntologies'
import {
  BASIC_LINEAGE_ONTOLOGY_ID,
  GraphSummary,
  OntologyMissingError,
  OntologyNotPublishedError,
  OntologyRequiredError,
  createGraph,
} from '@/services/versionControlService'

export type CreateGraphMode = 'schemaless' | 'simple_lineage' | 'strict'

export interface CreateGraphDialogProps {
  workspaceId: string
  isOpen: boolean
  onClose: () => void
  /** Called after a successful create. The host typically navigates
   *  to the new graph or refetches its list. */
  onCreated: (graph: GraphSummary) => void
}

interface ModeOption {
  value: CreateGraphMode
  label: string
  description: string
  icon: React.ReactNode
}

const MODES: ModeOption[] = [
  {
    value: 'schemaless',
    label: 'Blank canvas',
    description:
      'Free-form graph. No ontology bound — any node type, any edge type. Structural validation only (no dangling edges).',
    icon: <Sparkles className="w-5 h-5" />,
  },
  {
    value: 'simple_lineage',
    label: 'Simple lineage',
    description:
      'Pre-bound to the Basic Lineage ontology: Dataset, Pipeline, Service, Application; CONTAINS for hierarchy, FLOWS_TO/READS/WRITES for lineage.',
    icon: <GitBranch className="w-5 h-5" />,
  },
  {
    value: 'strict',
    label: 'Strict / pick ontology',
    description:
      'Choose a published ontology. The validator enforces type membership and a containment DAG on every commit.',
    icon: <Layers className="w-5 h-5" />,
  },
]

export function CreateGraphDialog({
  workspaceId,
  isOpen,
  onClose,
  onCreated,
}: CreateGraphDialogProps) {
  const [mode, setMode] = useState<CreateGraphMode>('schemaless')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [pickedOntologyId, setPickedOntologyId] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ontologiesQuery = useOntologies(false)
  const publishedOntologies = useMemo(
    () =>
      (ontologiesQuery.data ?? []).filter(
        (o) => o.isPublished && !o.deletedAt && o.id !== BASIC_LINEAGE_ONTOLOGY_ID,
      ),
    [ontologiesQuery.data],
  )

  const canSubmit =
    !submitting &&
    name.trim().length > 0 &&
    (mode !== 'strict' || pickedOntologyId.length > 0)

  function reset() {
    setMode('schemaless')
    setName('')
    setDescription('')
    setPickedOntologyId('')
    setSubmitting(false)
    setError(null)
  }

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      let schema_mode: 'schemaless' | 'strict' = 'schemaless'
      let ontology_id: string | null = null
      if (mode === 'simple_lineage') {
        schema_mode = 'strict'
        ontology_id = BASIC_LINEAGE_ONTOLOGY_ID
      } else if (mode === 'strict') {
        schema_mode = 'strict'
        ontology_id = pickedOntologyId
      }
      const graph = await createGraph(workspaceId, {
        name: name.trim(),
        description: description.trim() || undefined,
        schema_mode,
        ontology_id,
      })
      reset()
      onCreated(graph)
      onClose()
    } catch (err) {
      if (err instanceof OntologyRequiredError) {
        setError('Choose an ontology before continuing.')
      } else if (err instanceof OntologyMissingError) {
        setError(
          `The selected ontology (${err.ontologyId ?? 'unknown'}) was not found.`,
        )
      } else if (err instanceof OntologyNotPublishedError) {
        setError(
          'The selected ontology is not published. Publish it first or pick another.',
        )
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
      setSubmitting(false)
    }
  }

  if (!isOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4"
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.95, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.95, opacity: 0 }}
          className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl max-w-xl w-full p-6"
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-labelledby="create-graph-title"
        >
          <div className="flex items-start gap-3 mb-5">
            <div className="flex-1">
              <h3
                id="create-graph-title"
                className="text-lg font-semibold text-slate-900 dark:text-white"
              >
                Create a new graph
              </h3>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Pick how this graph will be structured. You can always
                edit content later; ontology choice can be changed only
                while the graph is empty.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="w-5 h-5 text-slate-400" />
            </button>
          </div>

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Finance lineage"
            aria-label="Graph name"
            className="w-full px-3 py-2 mb-4 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
          />

          <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
            Description (optional)
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What does this graph represent?"
            aria-label="Graph description"
            className="w-full px-3 py-2 mb-5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
          />

          <div className="space-y-2 mb-4" role="radiogroup" aria-label="Graph mode">
            {MODES.map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={mode === opt.value}
                onClick={() => setMode(opt.value)}
                className={cn(
                  'w-full p-3 rounded-lg border-2 text-left transition-all',
                  'hover:border-blue-300 dark:hover:border-blue-700',
                  mode === opt.value
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                    : 'border-slate-200 dark:border-slate-700',
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 text-blue-600 dark:text-blue-400">
                    {opt.icon}
                  </div>
                  <div className="flex-1">
                    <div className="text-sm font-medium text-slate-900 dark:text-white">
                      {opt.label}
                    </div>
                    <div className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                      {opt.description}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {mode === 'strict' && (
            <div className="mb-4">
              <label
                htmlFor="ontology-picker"
                className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1"
              >
                Ontology
              </label>
              <select
                id="ontology-picker"
                value={pickedOntologyId}
                onChange={(e) => setPickedOntologyId(e.target.value)}
                aria-label="Pick ontology"
                className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm"
              >
                <option value="">Select a published ontology…</option>
                {publishedOntologies.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} (v{o.version})
                  </option>
                ))}
              </select>
              {ontologiesQuery.isLoading && (
                <p className="mt-1 text-xs text-slate-500">Loading ontologies…</p>
              )}
              {!ontologiesQuery.isLoading && publishedOntologies.length === 0 && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  No published ontologies in this workspace. Publish one or
                  pick "Simple lineage" / "Blank canvas".
                </p>
              )}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="mb-4 p-3 rounded-md bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit}
              className={cn(
                'px-3 py-1.5 text-sm rounded-md font-medium',
                canSubmit
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-slate-200 dark:bg-slate-800 text-slate-400 cursor-not-allowed',
              )}
            >
              {submitting ? 'Creating…' : 'Create graph'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

export default CreateGraphDialog
