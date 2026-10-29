/**
 * The entity drawer's Edit tab: name, business label, description, the entity type's schema
 * fields, placement in the hierarchy, and the property bag. Every input edits the session's
 * working copy through `onEdit`; where a field is stored — top-level or among the properties — is
 * decided by `lib/nodeFields`.
 */
import { useId, useMemo, type ComponentType, type ReactNode } from 'react'
import { ArrowRight, AtSign, Briefcase, Check, Copy, Database, FileText, Layers, Link, Sparkles, Type, Unlink } from 'lucide-react'
import { useActiveView } from '@/store/schema'
import { normalizeReferenceLayout } from '@/utils/referenceLayout'
import { readSchemaField, toPayloadShape, withReserved, writeBusinessLabel, writeSchemaField } from '@/lib/nodeFields'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import {
  Note, NodeIdentityFacts, boundFieldIds, nameOnSave, useCanvasNodeIdentity,
} from '@/components/dataSource/NodeIdentity'
import { IconButton } from '@/components/ui/Button'
import { PropertyEditor } from '../PropertyEditor'
import { PanelErrorBoundary } from '../PanelErrorBoundary'
import { PlacementEditor } from './EntityPlacement'

type Data = Record<string, unknown>

/** Schema fields the form already shows as its own inputs. */
const FORM_FIELD_IDS = ['name', 'label', 'description', 'urn', 'businessLabel']

const INPUT = cn(
  'w-full px-3.5 py-2.5 rounded-xl text-sm text-ink placeholder:text-ink-muted outline-none transition-colors duration-150',
  'bg-black/[0.03] dark:bg-white/[0.04] border border-glass-border',
  'hover:border-black/20 dark:hover:border-white/20 focus:border-accent-lineage/60 focus:ring-2 focus:ring-accent-lineage/15',
)

function Field({ label, icon: Icon, hint, children }: {
  label: string
  icon?: ComponentType<{ className?: string }>
  hint?: ReactNode
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-xs font-semibold text-ink-muted flex items-center gap-2">
        {Icon && <Icon className="w-3.5 h-3.5" aria-hidden />}
        {label}
      </label>
      {children(id)}
      {hint && <p className="text-[11px] text-ink-muted">{hint}</p>}
    </div>
  )
}

interface SchemaField { id: string; name: string; type?: string }

/** What saving does to the data source's own name property, said under the Name input before it
 *  happens — the server's rule, predicted by `nameOnSave`. */
function nameHint(original: Data | null, form: Data, mapping: DataSourceResponse | null): ReactNode {
  const effect = nameOnSave(original && toPayloadShape(original), toPayloadShape(form), mapping, original === null)
  if (!effect) return null
  const prop = <code className="font-mono text-ink-secondary">{effect.property}</code>
  const quote = (v: unknown) => `“${String(v)}”`
  switch (effect.kind) {
    case 'follows':
      if (effect.from != null && !(typeof effect.from === 'string' && !effect.from.trim())) {
        return <Note tone="change" icon={ArrowRight}>{prop} changes to {quote(effect.to)} too.</Note>
      }
      return original === null ? <Note tone="good" icon={Check}>Also saved as {prop}.</Note>
        : <Note tone="change" icon={Sparkles}>{prop} is empty — it gets {quote(effect.to)} when saved.</Note>
    case 'renames':
      return <Note tone="change" icon={ArrowRight}>Saving renames it to {quote(effect.to)} to match {prop}.</Note>
    case 'same':
      return <Note tone="good" icon={Check}>Also saved as {prop}.</Note>
    case 'apart':
      return (
        <Note tone="apart" icon={Unlink}>
          {effect.edited ? <>{prop} is saved as {quote(effect.value)}, apart from the name.</>
            : effect.renamed ? <>{prop} stays {quote(effect.value)}: it is kept apart from the name.</>
              : <>{prop} is {quote(effect.value)}, kept apart from the name.</>}
        </Note>
      )
  }
}

export function EntityEditTab({ nodeId, form, original, entityType, urn, userProps, onEdit, onCopyUrn }: {
  nodeId: string
  form: Data
  /** The entity as first read — what a save is judged against — or null for one not saved yet. */
  original: Data | null
  entityType?: { fields?: SchemaField[] } | null
  urn: string
  /** The node's own properties (reserved names the reader mirrors in are left out). */
  userProps: Data
  onEdit: (update: (data: Data) => Data) => void
  onCopyUrn: () => void
}) {
  const set = (key: string, value: unknown) => onEdit((d) => ({ ...d, [key]: value }))
  // The Name input is also the source's own name property, and the platform assigns its identity
  // property: neither is offered as a schema field of its own.
  const identity = useCanvasNodeIdentity()
  const bound = boundFieldIds(identity)
  const schemaFields = (entityType?.fields ?? []).filter((f) => !FORM_FIELD_IDS.includes(f.id) && !bound.has(f.id))

  // Layer placement is VIEW config (referenceLayout.assignments), managed on the canvas — shown
  // here resolved and read-only.
  const activeView = useActiveView()
  const layerName = useMemo(() => {
    const { layers, assignments } = normalizeReferenceLayout(activeView?.layout?.referenceLayout)
    const layerId = assignments[urn]?.layerId
    return layerId ? (layers.find((l) => l.id === layerId)?.name ?? layerId) : ''
  }, [activeView?.layout?.referenceLayout, urn])

  const text = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v))

  return (
    <div className="p-5 space-y-5">
      <div className="space-y-4">
        <Field label="Name" icon={Type} hint={nameHint(original, form, identity)}>
          {(id) => <input id={id} type="text" className={INPUT} placeholder="Entity name…"
            value={text(form.label ?? form.name)} onChange={(e) => set('label', e.target.value)} />}
        </Field>
        <Field label="Business label" icon={Briefcase} hint="The name people in the business know it by — shown in Business mode.">
          {(id) => <input id={id} type="text" className={INPUT} placeholder="Business-friendly name…"
            value={text(form.businessLabel)} onChange={(e) => { const v = e.target.value; onEdit((d) => writeBusinessLabel(d, v)) }} />}
        </Field>
        <Field label="Description" icon={FileText}>
          {(id) => <textarea id={id} rows={3} className={cn(INPUT, 'resize-none')} placeholder="What is this, and what is it for?"
            value={text(form.description)} onChange={(e) => set('description', e.target.value)} />}
        </Field>
        <Field label="URN" icon={Link}>
          {(id) => (
            <div className="flex items-center gap-2">
              <input id={id} type="text" readOnly value={urn}
                className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl bg-black/[0.05] dark:bg-white/[0.04] text-ink-muted text-sm font-mono cursor-default outline-none" />
              <IconButton icon={Copy} label="Copy URN" variant="subtle" onClick={onCopyUrn} />
            </div>
          )}
        </Field>
        {/* The entity as stored: what this edit will do to it is the Name's hint above. */}
        <NodeIdentityFacts data={original ?? form} pending={original === null} />
      </div>

      <PlacementEditor nodeId={nodeId} />

      <div className="pt-5 border-t border-glass-border">
        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4">Metadata</h4>
        <div className="space-y-4">
          <Field label="Qualified name" icon={AtSign}>
            {(id) => <input id={id} type="text" className={INPUT} placeholder="Fully qualified name…"
              value={text(form.qualifiedName)} onChange={(e) => set('qualifiedName', e.target.value)} />}
          </Field>
          <Field label="Source system" icon={Database}>
            {(id) => <input id={id} type="text" className={INPUT} placeholder="Where it comes from…"
              value={text(form.sourceSystem)} onChange={(e) => set('sourceSystem', e.target.value)} />}
          </Field>
          <div className="space-y-1.5">
            <span className="text-xs font-semibold text-ink-muted flex items-center gap-2">
              <Layers className="w-3.5 h-3.5" aria-hidden />
              Layer
            </span>
            <p className="px-3.5 py-2.5 rounded-xl bg-black/[0.05] dark:bg-white/[0.04] text-ink-muted text-sm">
              {layerName || <span className="italic">Placed on the canvas</span>}
            </p>
          </div>
        </div>
      </div>

      {schemaFields.length > 0 && (
        <div className="pt-5 border-t border-glass-border">
          <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4">Schema properties</h4>
          <div className="space-y-4">
            {schemaFields.map((field) => (
              <Field key={field.id} label={field.name}>
                {(id) => field.type === 'textarea' || field.type === 'markdown' ? (
                  <textarea id={id} rows={2} className={cn(INPUT, 'resize-none')}
                    value={text(readSchemaField(form, field.id))}
                    onChange={(e) => { const v = e.target.value; onEdit((d) => writeSchemaField(d, field.id, v)) }} />
                ) : (
                  <input id={id} type="text" className={INPUT}
                    value={text(readSchemaField(form, field.id))}
                    onChange={(e) => { const v = e.target.value; onEdit((d) => writeSchemaField(d, field.id, v)) }} />
                )}
              </Field>
            ))}
          </div>
        </div>
      )}

      <div className="pt-5 border-t border-glass-border">
        <h4 className="text-xs font-semibold text-ink-muted uppercase tracking-wider mb-4">Properties</h4>
        <div className="-mx-3">
          <PanelErrorBoundary resetKeys={[urn]}>
            <PropertyEditor
              value={userProps}
              onChange={(next) => onEdit((d) => {
                const bag = next as Data
                // The business label is a property the header also shows — keep the two as one.
                return {
                  ...d,
                  properties: withReserved(d.properties, bag),
                  businessLabel: typeof bag.businessLabel === 'string' ? bag.businessLabel : undefined,
                }
              })}
              searchable
              groupByPath
              bare
            />
          </PanelErrorBoundary>
        </div>
      </div>
    </div>
  )
}
