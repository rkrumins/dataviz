/**
 * EntityOverview — the entity at a glance: the first thing the Business view's
 * drawer shows, and a section the Technical view can switch on.
 *
 * It answers what a reader came to ask, in the order they ask it: what the
 * view's rules say about it (its tags), what it is (the description, read as
 * written), and the few facts that place it — its ID, how much sits inside it,
 * its layer and source, and the properties its type features (an owner, a
 * steward, a status). Each fact is a tile, typed (a person as a person, a date
 * as a date, a link as a link), so nothing reads as raw data; the ID copies.
 *
 * Which properties are featured is the reader's to choose, per entity type,
 * from the drawer's Customize panel; until then, the type's own panel fields
 * and an owner, where the entity has them.
 */
import { Sparkles } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'

import { DisplayRuleTagChips } from '@/components/canvas/property-manager/DisplayRuleTagChips'
import { CopyButton } from '@/components/ui/CopyButton'
import { ValueView, humanizeKey } from '@/components/ui/ValueView'
import { usePreferencesStore } from '@/store/preferences'
import type { EntityFieldDefinition } from '@/types/schema'

import { Section } from '../DrawerSection'
import { ClampedText } from '../property/valueWidgets'
import { propertyLabel, resolveFeatured } from './drawerLayout'

type Data = Record<string, unknown>

/** The identifier's name, as a reader would say it. */
function identifierLabel(property: string): string {
  if (property === 'id') return 'ID'
  if (property === 'urn') return 'URN'
  return humanizeKey(property)
}

export function EntityOverview({ form, urn, identity, childCount, typeId, fields }: {
  form: Data
  urn: string
  /** The entity's identifier: its data source's identity property and value, or its URN. */
  identity?: { property: string; value: string }
  childCount: number
  typeId: string
  fields?: readonly EntityFieldDefinition[]
}) {
  const pinned = usePreferencesStore((s) => s.drawerPinnedProperties[typeId])
  const featured = useMemo(() => resolveFeatured(pinned, fields, form), [pinned, fields, form])
  const description = typeof form.description === 'string' ? form.description.trim() : ''
  const layer = typeof form.layerAssignment === 'string' ? form.layerAssignment : ''
  const source = typeof form.sourceSystem === 'string' ? form.sourceSystem : ''

  return (
    <Section title="At a glance" icon={Sparkles}>
      <div className="space-y-3.5">
        <DisplayRuleTagChips urn={urn} size="sm" max={4} />

        {description ? (
          <div className="text-ink [&_.text-xs]:text-[13px] [&_.text-xs]:leading-relaxed">
            <ClampedText text={description} />
          </div>
        ) : (
          <p className="text-[13px] italic text-ink-muted">No description yet.</p>
        )}

        <dl className="grid gap-2 grid-cols-[repeat(auto-fill,minmax(150px,1fr))]">
          {identity && (
            <Fact label={identifierLabel(identity.property)} copy={identity.value}>
              <span className="font-mono text-[12px] break-all">{identity.value}</span>
            </Fact>
          )}
          {childCount > 0 && (
            <Fact label="Inside">
              {childCount.toLocaleString()} {childCount === 1 ? 'entity' : 'entities'}
            </Fact>
          )}
          {layer && <Fact label="Layer">{layer}</Fact>}
          {source && <Fact label="Source system">{source}</Fact>}
          {featured.map(({ key, value }) => (
            <Fact key={key} label={propertyLabel(key, fields)}>
              {value === undefined || value === null || value === ''
                ? <span className="italic text-ink-muted">Not set</span>
                : <ValueView value={value} keyHint={key} />}
            </Fact>
          ))}
        </dl>
      </div>
    </Section>
  )
}

function Fact({ label, copy, children }: { label: string; copy?: string; children: ReactNode }) {
  return (
    <div className="group relative min-w-0 rounded-xl border border-glass-border bg-gradient-to-br from-black/[0.015] to-black/[0.035] px-3 py-2.5 dark:from-white/[0.02] dark:to-white/[0.045]">
      <dt className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-muted">{label}</dt>
      <dd className="mt-1 min-w-0 text-[13px] leading-snug text-ink break-words">{children}</dd>
      {copy && (
        <CopyButton value={copy} label={`Copy ${label}`}
                    className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100" />
      )}
    </div>
  )
}
