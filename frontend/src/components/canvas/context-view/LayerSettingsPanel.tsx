/**
 * LayerSettingsPanel — one layer, in a panel of its own.
 *
 * A layer's facts were scattered over five surfaces (the column header, its
 * right-click menu, the wizard, Layer Studio, the template editor) and crowded
 * into a header a few hundred pixels wide. Here they sit in the order a person
 * reaches for them: the essentials — name, description, colour, icon — then
 * the layer's own properties (an owner, a purpose, an SLA), then, folded under
 * More, what is rarely touched. In a draft every field is editable and Stage
 * keeps the change for Review & Save, like any other layer edit; outside one it
 * is the same panel, read-only — the layer's details, with the way into a draft.
 */
import { AlertCircle, ChevronDown, FileText, Layers, Sparkles, Trash2, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { ToggleSwitch } from '@/components/admin/AdminFeatures/ToggleSwitch'
import { Button, IconButton } from '@/components/ui/Button'
import { ColorInput } from '@/components/ui/ColorInput'
import { DynamicIcon } from '@/components/ui/DynamicIcon'
import { IconPicker } from '@/components/ui/IconPicker'
import { ValueView, humanizeKey } from '@/components/ui/ValueView'
import { useViewEntityTypes } from '@/hooks/useViewSchema'
import { cn } from '@/lib/utils'
import type { ViewLayerConfig } from '@/types/schema'

import { PropertyEditor } from '../../panels/PropertyEditor'
import { DrawerBody, DrawerFooter, DrawerFrame, DrawerHeader } from '../../panels/shell/DrawerShell'
import type { LayerPatch } from './layerMutations'

const LABEL = 'block text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted'
const INPUT = 'w-full rounded-lg border border-black/[0.10] dark:border-white/[0.10] bg-canvas px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
const CARD = 'rounded-2xl border border-black/[0.08] dark:border-white/[0.08] bg-black/[0.015] dark:bg-white/[0.02] p-4'

export function LayerSettingsPanel({ layer, canEdit, onSave, onDelete, onStartEditing, onClose }: {
  layer: ViewLayerConfig
  /** In a draft: the panel edits; otherwise it shows the layer's details. */
  canEdit: boolean
  /** Keep the changed fields (staged for Review & Save). */
  onSave: (patch: LayerPatch) => void
  onDelete?: () => void
  /** Outside a draft: open one. */
  onStartEditing?: () => void
  onClose: () => void
}) {
  // The layer as the panel opened on it. Stage keeps only what was changed
  // here, so an edit made elsewhere meanwhile (a rename in the header, a colour
  // from the menu) is never undone by a field left alone.
  const [opened] = useState(layer)
  const openedColor = opened.color ?? '#6366f1'
  const [name, setName] = useState(opened.name)
  const [description, setDescription] = useState(opened.description ?? '')
  const [pickedColor, setPickedColor] = useState(openedColor)
  const [icon, setIcon] = useState(opened.icon ?? 'Layers')
  const [properties, setProperties] = useState<Record<string, unknown>>(opened.properties ?? {})
  const [showUnassigned, setShowUnassigned] = useState(!!opened.showUnassigned)
  const [moreOpen, setMoreOpen] = useState(false)
  const [iconOpen, setIconOpen] = useState(false)

  const patch = useMemo(() => {
    const p: LayerPatch = {}
    const trimmed = name.trim()
    if (trimmed && trimmed !== opened.name) p.name = trimmed
    if (description !== (opened.description ?? '')) p.description = description
    if (pickedColor !== openedColor) p.color = pickedColor
    if (icon !== (opened.icon ?? 'Layers')) p.icon = icon
    if (JSON.stringify(properties) !== JSON.stringify(opened.properties ?? {})) p.properties = properties
    if (showUnassigned !== !!opened.showUnassigned) p.showUnassigned = showUnassigned
    return p
  }, [name, description, pickedColor, icon, properties, showUnassigned, opened, openedColor])
  const dirty = Object.keys(patch).length > 0

  const color = layer.color ?? '#6366f1'
  const shownColor = canEdit ? pickedColor : color
  const propertyCount = Object.keys(canEdit ? properties : layer.properties ?? {}).length
  const entityTypes = useViewEntityTypes()
  const typeName = (id: string) => entityTypes.find((t) => t.id.toLowerCase() === id.toLowerCase())?.name ?? id

  return (
    <DrawerFrame panel="layer-settings" label={canEdit ? 'Layer settings' : 'Layer details'}>
      <DrawerHeader style={{ background: `linear-gradient(135deg, ${shownColor}1f 0%, transparent 65%)` }}>
        <div className="flex items-start gap-3">
          <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-sm"
                style={{ backgroundColor: `${shownColor}26`, color: shownColor }}>
            <DynamicIcon name={canEdit ? icon : (layer.icon ?? 'Layers')} className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em]" style={{ color: shownColor }}>
              {canEdit ? 'Layer settings' : 'Layer details'}
            </p>
            <h2 className="truncate text-lg font-semibold leading-tight text-ink">{canEdit ? (name.trim() || layer.name) : layer.name}</h2>
          </div>
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>
      </DrawerHeader>

      <DrawerBody>
        <div className="space-y-3.5 p-4">
          {!canEdit && (
            <div className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
              <div className="min-w-0 flex-1 text-[12px] leading-snug text-ink">
                Layers change in a draft, and are published from there.
                {onStartEditing && (
                  <div className="mt-2">
                    <Button size="sm" variant="secondary" onClick={onStartEditing}>Start editing</Button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Essentials */}
          <section aria-label="Essentials" className={CARD}>
            <div className="mb-3 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-ink-muted" aria-hidden />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Essentials</h3>
            </div>
            {canEdit ? (
              <div className="space-y-3">
                <label className="block">
                  <span className={cn(LABEL, 'mb-1')}>Name</span>
                  <input aria-label="Layer name" value={name} onChange={(e) => setName(e.target.value)} className={INPUT} />
                </label>
                <label className="block">
                  <span className={cn(LABEL, 'mb-1')}>Description</span>
                  <textarea aria-label="Layer description" rows={3} value={description} placeholder="What this layer holds, and why"
                            onChange={(e) => setDescription(e.target.value)} className={cn(INPUT, 'resize-y leading-relaxed')} />
                </label>
                <div>
                  <span className={cn(LABEL, 'mb-1.5')}>Colour</span>
                  <ColorInput value={pickedColor} onChange={setPickedColor} />
                </div>
                <div>
                  <button type="button" onClick={() => setIconOpen((v) => !v)} aria-expanded={iconOpen}
                          className="flex w-full items-center gap-2 text-left">
                    <span className={LABEL}>Icon</span>
                    <DynamicIcon name={icon} className="h-3.5 w-3.5 text-ink-muted" />
                    <ChevronDown className={cn('ml-auto h-3.5 w-3.5 text-ink-muted transition-transform', iconOpen && 'rotate-180')} aria-hidden />
                  </button>
                  {iconOpen && <div className="mt-2"><IconPicker value={icon} onChange={setIcon} /></div>}
                </div>
              </div>
            ) : (
              <dl className="space-y-2.5">
                <div>
                  <dt className={LABEL}>Description</dt>
                  <dd className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
                    {layer.description || <span className="italic text-ink-muted">No description yet.</span>}
                  </dd>
                </div>
                {layer.entityTypes.length > 0 && (
                  <div>
                    <dt className={LABEL}>Holds types</dt>
                    <dd className="mt-1 flex flex-wrap gap-1">
                      {layer.entityTypes.map((t) => (
                        <span key={t} className="rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11.5px] text-ink dark:bg-white/[0.06]">{typeName(t)}</span>
                      ))}
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </section>

          {/* Custom properties */}
          <section aria-label="Custom properties" className={CARD}>
            <div className="mb-2 flex items-center gap-2">
              <FileText className="h-4 w-4 text-ink-muted" aria-hidden />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Custom properties</h3>
              <span className="ml-auto text-[11px] tabular-nums text-ink-muted">{propertyCount}</span>
            </div>
            <p className="mb-2 text-[11.5px] leading-snug text-ink-muted">
              What a reader should know about this layer — an owner, a purpose, an SLA. Shown on its card.
            </p>
            {canEdit ? (
              <div className="-mx-3.5">
                <PropertyEditor value={properties} onChange={(next) => setProperties((next ?? {}) as Record<string, unknown>)} bare />
              </div>
            ) : propertyCount > 0 ? (
              // Read the way the layer's card reads them.
              <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2">
                {Object.entries(layer.properties ?? {}).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="truncate text-[12px] text-ink-muted">{humanizeKey(key)}</dt>
                    <dd className="min-w-0 break-words text-[13px] text-ink"><ValueView value={value} keyHint={key} /></dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-[12px] italic text-ink-muted">None yet.</p>
            )}
          </section>

          {/* More — what is rarely touched */}
          {canEdit && (
            <section aria-label="More" className={CARD}>
              <button type="button" onClick={() => setMoreOpen((v) => !v)} aria-expanded={moreOpen}
                      className="flex w-full items-center gap-2 text-left">
                <Layers className="h-4 w-4 text-ink-muted" aria-hidden />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">More</h3>
                <ChevronDown className={cn('ml-auto h-3.5 w-3.5 text-ink-muted transition-transform', moreOpen && 'rotate-180')} aria-hidden />
              </button>
              {moreOpen && (
                <div className="mt-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <label htmlFor="layer-show-unassigned" className="min-w-0 cursor-pointer">
                      <span className="block text-[12.5px] font-medium text-ink">Show unassigned entities</span>
                      <span className="block text-[11.5px] text-ink-muted">Entities no layer has placed, listed in this one.</span>
                    </label>
                    <ToggleSwitch id="layer-show-unassigned" size="sm" checked={showUnassigned} onChange={setShowUnassigned}
                                  aria-label="Show unassigned entities" />
                  </div>
                  <p className="text-[11.5px] leading-snug text-ink-muted">
                    Which entities this layer holds is set by its placement rules, in the view editor.
                  </p>
                  {onDelete && (
                    <Button size="sm" variant="danger" leftIcon={Trash2} onClick={onDelete}>Delete layer</Button>
                  )}
                </div>
              )}
            </section>
          )}
        </div>
      </DrawerBody>

      {canEdit && (
        <DrawerFooter className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11.5px] text-ink-muted">
            {dirty ? 'Kept for Review & Save — nothing is saved yet.' : 'Nothing changed yet.'}
          </span>
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!dirty} onClick={() => { onSave(patch); onClose() }}>Stage changes</Button>
        </DrawerFooter>
      )}
    </DrawerFrame>
  )
}
