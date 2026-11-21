/**
 * PromoteFieldDialog — "Make it a field…": an ad-hoc property, made a field of the entity types that
 * carry it, in the data source's semantic layer. Prefilled from what the catalog read of it: the key
 * (the field's id is the property it reads and writes), a type from the kinds it is stored as,
 * candidate allowed values when it holds few, and the types it is on. A field can then be required,
 * kept to allowed values, and is typed — what publishing a draft holds its values to.
 *
 * Where the field goes follows the semantic layer's lifecycle, said before anything is written:
 * - a draft layer is changed in place;
 * - a published one changes by a new version: added to a newer draft version if there is one, else
 *   saved as a new draft version — published and assigned to the data source from the semantic layer;
 * - the built-in layer can't change (it is cloned first, in the semantic layer); with no layer
 *   assigned there is nothing to add it to. Both say so, with the way there.
 */
import { useMemo, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Info, ListChecks, Lock, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { Backdrop } from '@/components/ui/Backdrop'
import { Button, IconButton } from '@/components/ui/Button'
import { useAppNotifications } from '@/components/ui/notifications'
import { AllowedValuesEditor } from '@/components/schema/AllowedValuesEditor'
import { useWorkspacesStore } from '@/store/workspaces'
import { useOntologyDefinition } from '@/hooks/useOntologyDefinition'
import { useOntologyMutations } from '@/features/ontology/hooks/useOntologyMutations'
import { caseFold } from '@/features/ontology/lib/caseFold'
import { humanizeId } from '@/features/ontology/lib/ontology-parsers'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import type { EntityFieldDefinition } from '@/types/schema'
import type { SearchCatalogProperty } from '@/types/search'
import { storedType } from './propertyValueTypes'

/** A key holding at most this many distinct values offers them all as allowed values. */
const CANDIDATES_MAX = 25

const TYPE_OPTIONS: Array<{ value: EntityFieldDefinition['type']; label: string }> = [
  { value: 'string', label: 'Text' }, { value: 'number', label: 'Number' }, { value: 'boolean', label: 'Yes / No' },
  { value: 'date', label: 'Date' }, { value: 'datetime', label: 'Date & time' }, { value: 'url', label: 'Link' },
  { value: 'email', label: 'Email' }, { value: 'tags', label: 'Tags' }, { value: 'status', label: 'Status' },
]

type Defs = Record<string, Record<string, unknown>>

/** Where the field goes, by the semantic layer's lifecycle (see the header). */
type Target =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'locked'; ontology: OntologyDefinitionResponse }
  | { kind: 'inPlace'; ontology: OntologyDefinitionResponse; assigned: OntologyDefinitionResponse }
  | { kind: 'newVersion'; ontology: OntologyDefinitionResponse }

export function PromoteFieldDialog({ property, onClose }: { property: SearchCatalogProperty; onClose: () => void }) {
  const { notify } = useAppNotifications()
  const navigate = useNavigate()
  const wsId = useWorkspacesStore((s) => s.activeWorkspaceId)
  const dataSource = useWorkspacesStore((s) => s.getActiveDataSource())
  const ontologyId = dataSource?.ontologyId ?? null
  const { ontology, isLoading } = useOntologyDefinition(ontologyId)
  // A published layer changes by a newer version: one already drafted takes the field.
  const versions = useQuery({
    queryKey: ['ontology-versions', ontology?.id],
    queryFn: () => ontologyDefinitionService.listVersions(ontology!.id),
    enabled: !!ontology && ontology.isPublished && !ontology.isSystem && !ontology.deletedAt,
    retry: false,
  })
  const target: Target = useMemo(() => {
    if (!ontologyId) return { kind: 'none' }
    if (isLoading) return { kind: 'loading' }
    if (!ontology) return { kind: 'unreadable' }
    if (ontology.isSystem || ontology.deletedAt) return { kind: 'locked', ontology }
    if (!ontology.isPublished) return { kind: 'inPlace', ontology, assigned: ontology }
    if (versions.isLoading) return { kind: 'loading' }
    const next = (versions.data ?? []).filter((v) => !v.isPublished && !v.deletedAt && v.version > ontology.version)
      .sort((a, b) => b.version - a.version)[0]
    return next ? { kind: 'inPlace', ontology: next, assigned: ontology } : { kind: 'newVersion', ontology }
  }, [ontologyId, isLoading, ontology, versions.isLoading, versions.data])
  const editing = target.kind === 'inPlace' || target.kind === 'newVersion' ? target.ontology : null

  // ── The field, prefilled from the catalog ──
  const key = property.key
  const [name, setName] = useState(() => humanizeId(key))
  const [type, setType] = useState<EntityFieldDefinition['type']>(() => {
    const t = storedType(property.kinds).type
    return t === 'number' ? 'number' : t === 'boolean' ? 'boolean' : t === 'list' ? 'tags' : 'string'
  })
  const [required, setRequired] = useState(false)
  const [allowed, setAllowed] = useState<{ values: string[]; allowOther: boolean }>({ values: [], allowOther: false })
  const candidates = useMemo(() => (property.distinctExact && property.distinct <= CANDIDATES_MAX
    ? [...new Set(property.values.map((v) => (typeof v.value === 'string' ? v.value.trim() : JSON.stringify(v.value))).filter(Boolean))]
    : []), [property])

  // The types it is on, as the semantic layer declares them (matched case-insensitively).
  const defs = useMemo(() => ((editing?.entityTypeDefinitions ?? {}) as Defs), [editing])
  const onTypes = useMemo(() => Object.entries(property.byEntityType).sort((a, b) => b[1] - a[1]).map(([t, count]) => {
    const declared = Object.keys(defs).find((d) => caseFold(d) === caseFold(t)) ?? null
    const fields = ((declared ? defs[declared]?.fields : null) ?? []) as Array<Record<string, unknown>>
    return { type: t, count, declared, already: fields.some((f) => f.id === key) }
  }), [property.byEntityType, defs, key])
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set())
  const chosen = onTypes.filter((t) => t.declared && !t.already && !unchecked.has(t.type))
  const toggleType = (t: string) => setUnchecked((s) => { const n = new Set(s); if (n.has(t)) n.delete(t); else n.add(t); return n })

  const mutations = useOntologyMutations()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const schemaUrl = (id: string) => {
    const qs = new URLSearchParams()
    if (wsId) qs.set('workspaceId', wsId)
    if (dataSource?.id) qs.set('dataSourceId', dataSource.id)
    return `/schema/${id}?${qs.toString()}`
  }
  const openLayer = (id: string) => { onClose(); navigate(schemaUrl(id)) }

  const save = async () => {
    if (!editing || chosen.length === 0 || !name.trim()) return
    setSaving(true)
    setError(null)
    try {
      const next: Defs = { ...defs }
      for (const t of chosen) {
        const def = next[t.declared!] ?? {}
        const fields = ((def.fields as Array<Record<string, unknown>>) ?? [])
        next[t.declared!] = {
          ...def,
          fields: [...fields, {
            id: key, name: name.trim(), type, required,
            show_in_node: false, show_in_panel: true, show_in_tooltip: false, display_order: fields.length,
            ...(allowed.values.length ? { allowed_values: allowed.values } : {}),
            ...(allowed.values.length && allowed.allowOther ? { allow_other: true } : {}),
          }],
        }
      }
      const saved = await mutations.update.mutateAsync({ id: editing.id, req: { entityTypeDefinitions: next } })
      const where = chosen.map((t) => t.declared).join(', ')
      if (target.kind === 'inPlace' && target.ontology.id === target.assigned.id) {
        notify('success', `${name.trim()} is a field of ${where} in “${saved.name}”.`,
          { label: 'Open the semantic layer', onClick: () => navigate(schemaUrl(saved.id)) })
      } else {
        notify('success',
          `${name.trim()} is a field of ${where} in v${saved.version} of “${saved.name}”, a draft — publish it and assign it to this data source to put it in force.`,
          { label: `Open v${saved.version}`, onClick: () => navigate(schemaUrl(saved.id)) })
      }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The semantic layer could not be changed.')
    } finally {
      setSaving(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return
    if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }
  const problem = !editing ? null
    : !name.trim() ? 'Name the field'
      : onTypes.every((t) => !t.declared) ? 'None of the types it is on are in the semantic layer'
        : chosen.length === 0 ? 'Pick a type to add it to' : null

  if (typeof document === 'undefined') return null
  return createPortal(
    <>
      <Backdrop open onClick={onClose} zClassName="z-[80]" className="bg-black/50" />
      <div className="fixed inset-0 z-[80] flex items-center justify-center p-4 pointer-events-none" onKeyDown={onKeyDown}>
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-labelledby="promote-field-title"
          initial={{ opacity: 0, scale: 0.96, y: 6 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={MOTION.modalSpring}
          className="pointer-events-auto relative flex max-h-[88vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-glass-border bg-canvas-elevated shadow-2xl shadow-black/40"
        >
          <div className="flex items-start gap-3 border-b border-glass-border px-5 py-4 bg-gradient-to-br from-accent-lineage/[0.07] to-transparent">
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-lineage/15 text-accent-lineage">
              <ListChecks className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h3 id="promote-field-title" className="text-[15px] font-semibold leading-tight text-ink">
                Make <span className="font-mono">{key}</span> a field
              </h3>
              <p className="mt-0.5 text-[11.5px] text-ink-muted">
                A field of its entity types, in the semantic layer: typed, and optionally required or kept to allowed values — what publishing a draft holds it to.
              </p>
            </div>
            <IconButton icon={X} label="Close" shortcut="Esc" onClick={onClose} />
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-5 py-4 space-y-4">
            <Where target={target} onOpen={openLayer} />

            {editing && (
              <>
                <div className="grid grid-cols-[1fr_auto] gap-2">
                  <label className="space-y-1">
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Field name"
                      className="w-full rounded-lg border border-glass-border bg-canvas px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-lineage/30" />
                  </label>
                  <label className="space-y-1">
                    <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">Type</span>
                    <select value={type} onChange={(e) => setType(e.target.value as EntityFieldDefinition['type'])} aria-label="Field type"
                      className="rounded-lg border border-glass-border bg-canvas px-2 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-lineage/30">
                      {TYPE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </label>
                </div>
                <p className="-mt-2 text-[11px] text-ink-muted">
                  Reads and writes the property <span className="font-mono text-ink">{key}</span>
                  {storedType(property.kinds).mixed && ' — stored as more than one kind today; values not of the type are warned of while editing'}.
                </p>

                <div>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted mb-1">On</span>
                  <div className="space-y-1">
                    {onTypes.map((t) => (
                      <label key={t.type} className={cn('flex items-center gap-2 text-[12px]', t.declared && !t.already ? 'cursor-pointer text-ink' : 'text-ink-muted')}>
                        <input type="checkbox" disabled={!t.declared || t.already}
                          checked={!!t.declared && !t.already && !unchecked.has(t.type)} onChange={() => toggleType(t.type)}
                          className="h-3.5 w-3.5 rounded accent-indigo-500" />
                        <span className="font-medium">{t.declared ?? t.type}</span>
                        <span className="text-[11px] text-ink-muted tabular-nums">{t.count.toLocaleString()} carry it</span>
                        {t.already && <span className="text-[11px] text-ink-muted">· a field already</span>}
                        {!t.declared && <span className="text-[11px] text-ink-muted">· not a type of this semantic layer</span>}
                      </label>
                    ))}
                  </div>
                </div>

                <label className="flex items-start gap-2 cursor-pointer select-none">
                  <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="mt-0.5 h-3.5 w-3.5 rounded accent-indigo-500" />
                  <span className="text-[12px] text-ink">
                    Required
                    <span className="block text-[11px] text-ink-muted">
                      {property.count.toLocaleString()} hold it now. A draft that adds one of these types without it, or empties it, can’t be published — existing ones are judged only when they change.
                    </span>
                  </span>
                </label>

                <div>
                  <span className="block text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted mb-1">Allowed values</span>
                  <AllowedValuesEditor values={allowed.values} allowOther={allowed.allowOther} candidates={candidates}
                    onChange={(values, allowOther) => setAllowed({ values, allowOther })} label={`Allowed values of ${name || key}`} />
                  {candidates.length > 0 && allowed.values.length === 0 && (
                    <button type="button" onClick={() => setAllowed({ values: candidates, allowOther: false })}
                      className="mt-1.5 text-[11px] font-semibold text-accent-lineage hover:underline">
                      Allow just the {candidates.length} values it holds
                    </button>
                  )}
                </div>
              </>
            )}
          </div>

          {(target.kind === 'inPlace' || target.kind === 'newVersion') && (
            <div className="flex items-center gap-2 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] px-5 py-3">
              <span role={error ? 'alert' : undefined} className={cn('min-w-0 flex-1 text-[11.5px]', error ? 'text-rose-600 dark:text-rose-400' : 'text-ink-muted')}>
                {error ?? problem ?? ''}
              </span>
              <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
              <Button size="sm" variant="primary" disabled={!!problem} loading={saving} onClick={() => void save()}>
                {target.kind === 'newVersion' ? 'Save as a new version' : 'Add the field'}
              </Button>
            </div>
          )}
        </motion.div>
      </div>
    </>,
    document.body,
  )
}

/** Where the field goes, said before anything is written — or why it can't go anywhere yet. */
function Where({ target, onOpen }: { target: Target; onOpen: (id: string) => void }) {
  const note = (icon: typeof Info, children: React.ReactNode, action?: { label: string; id: string }) => {
    const Icon = icon
    return (
      <div className="flex items-start gap-2 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] p-2.5 text-[11.5px] leading-snug text-ink-secondary">
        <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          {children}
          {action && (
            <button type="button" onClick={() => onOpen(action.id)}
              className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-accent-lineage hover:underline">
              {action.label} <ArrowRight className="h-3 w-3" aria-hidden />
            </button>
          )}
        </div>
      </div>
    )
  }
  switch (target.kind) {
    case 'loading': return <p className="text-[11.5px] text-ink-muted">Reading this data source’s semantic layer…</p>
    case 'none': return note(Info, <>This data source has no semantic layer to add a field to. Assign one from the semantic layer first.</>)
    case 'unreadable': return note(Lock, <>This data source’s semantic layer couldn’t be read — you may not be able to see it.</>)
    case 'locked': return note(Lock, <>
      <span className="font-medium text-ink">“{target.ontology.name}”</span> is {target.ontology.isSystem ? 'the built-in semantic layer' : 'deleted'}, and can’t be changed.
      Clone it, assign the clone to this data source, and add the field there.
    </>, { label: 'Open the semantic layer', id: target.ontology.id })
    case 'inPlace': return target.ontology.id === target.assigned.id
      ? note(Info, <>Added to <span className="font-medium text-ink">“{target.ontology.name}”</span>, a draft semantic layer, as you save it.</>)
      : note(Info, <>
        <span className="font-medium text-ink">“{target.assigned.name}”</span> is published: it changes by a new version. This adds the field to
        v{target.ontology.version}, the draft already started — publish it and assign it to this data source to put it in force.
      </>, { label: `Open v${target.ontology.version}`, id: target.ontology.id })
    case 'newVersion': return note(Info, <>
      <span className="font-medium text-ink">“{target.ontology.name}”</span> is published: it changes by a new version. Saving makes
      a new draft version with this field — publish it and assign it to this data source to put it in force.
    </>)
  }
}
