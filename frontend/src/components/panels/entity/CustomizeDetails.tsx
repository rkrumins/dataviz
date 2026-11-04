/**
 * CustomizeDetails — the entity drawer, arranged the reader's way.
 *
 * Two things can be chosen. Which SECTIONS the drawer shows, and in what
 * order — kept per view, so the Business view can stay at a glance while the
 * Technical view keeps everything. And which PROPERTIES are featured at the
 * top, for this entity type — kept per type, because what matters about a
 * table (its owner, its SLA) is not what matters about a domain.
 *
 * Every change applies at once and is saved in this browser; Reset puts the
 * view's sections and this type's properties back to their defaults. Moves
 * are buttons, not only drags, so the keyboard can do all of it.
 */
import { ArrowDown, ArrowUp, Eye, EyeOff, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react'
import { motion } from 'framer-motion'
import { useMemo, useState } from 'react'

import { Button, IconButton } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { usePersonaMode } from '@/store/persona'
import { usePreferencesStore } from '@/store/preferences'
import type { EntityFieldDefinition } from '@/types/schema'

import {
  SECTION_LABELS, defaultFeatured, isDefaultLayout, moveSection, propertyLabel, resolveLayout, setSectionShown,
} from './drawerLayout'

const ROW = 'flex items-center gap-2 rounded-lg px-2.5 py-1.5 bg-canvas-elevated border border-glass-border'

export function CustomizeDetails({ typeId, typeName, fields, propertyKeys, onDone }: {
  typeId: string
  typeName: string
  fields?: readonly EntityFieldDefinition[]
  /** This entity's own properties: what can be featured from here. */
  propertyKeys: readonly string[]
  onDone: () => void
}) {
  const mode = usePersonaMode()
  const stored = usePreferencesStore((s) => s.drawerLayout?.[mode] ?? null)
  const setLayout = usePreferencesStore((s) => s.setDrawerLayout)
  const pinned = usePreferencesStore((s) => s.drawerPinnedProperties[typeId])
  const setPinned = usePreferencesStore((s) => s.setDrawerPinnedProperties)
  const layout = resolveLayout(stored, mode)
  const hidden = new Set(layout.hidden)

  // Featured: the type's own choice, or — until one is made — its defaults
  // that this entity has, so the list starts from what the reader sees.
  const featured = useMemo(
    () => pinned ?? defaultFeatured(fields).filter((k) => propertyKeys.includes(k)),
    [pinned, fields, propertyKeys],
  )
  const addable = propertyKeys.filter((k) => !featured.includes(k))
  const [adding, setAdding] = useState('')

  const writeFeatured = (keys: string[]) => setPinned(typeId, keys)
  const moveFeatured = (key: string, by: -1 | 1) => {
    const i = featured.indexOf(key)
    const j = i + by
    if (j < 0 || j >= featured.length) return
    const next = [...featured]
    ;[next[i], next[j]] = [next[j], next[i]]
    writeFeatured(next)
  }
  const isDefault = isDefaultLayout(layout, mode) && pinned === undefined
  const reset = () => {
    setLayout(mode, null)
    setPinned(typeId, null)
  }

  return (
    <motion.section
      aria-label="Customize details"
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: 'easeOut' }}
      className="m-4 rounded-2xl border border-accent-lineage/30 bg-gradient-to-b from-accent-lineage/[0.06] to-transparent p-4 shadow-sm shadow-accent-lineage/10"
    >
      <header className="flex items-start gap-2.5">
        <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-accent-lineage/15 text-accent-lineage">
          <SlidersHorizontal className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-ink">Customize details</h3>
          <p className="text-[11.5px] leading-snug text-ink-muted">
            For the {mode === 'business' ? 'Business' : 'Technical'} view, saved in this browser.
          </p>
        </div>
        {!isDefault && (
          <Button size="sm" variant="ghost" leftIcon={RotateCcw} onClick={reset}>Reset</Button>
        )}
        <Button size="sm" variant="secondary" onClick={onDone}>Done</Button>
      </header>

      <h4 className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">Sections</h4>
      <ul className="space-y-1">
        {layout.order.map((id, i) => {
          const shown = !hidden.has(id)
          const label = SECTION_LABELS[id]
          return (
            <motion.li key={id} layout transition={{ duration: 0.16 }} className={cn(ROW, !shown && 'opacity-60')}>
              <span className="flex-1 truncate text-[12.5px] font-medium text-ink">{label}</span>
              <IconButton size="sm" variant="ghost" icon={ArrowUp} label={`Move ${label} up`}
                          disabled={i === 0} onClick={() => setLayout(mode, moveSection(layout, id, -1))} />
              <IconButton size="sm" variant="ghost" icon={ArrowDown} label={`Move ${label} down`}
                          disabled={i === layout.order.length - 1} onClick={() => setLayout(mode, moveSection(layout, id, 1))} />
              <IconButton size="sm" variant="ghost" icon={shown ? Eye : EyeOff}
                          label={shown ? `Hide ${label}` : `Show ${label}`} aria-pressed={shown}
                          onClick={() => setLayout(mode, setSectionShown(layout, id, !shown))} />
            </motion.li>
          )
        })}
      </ul>

      <h4 className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
        Featured properties · {typeName}
      </h4>
      {featured.length === 0 ? (
        <p className="text-[11.5px] text-ink-muted">None yet — feature one below, and it shows at a glance for every {typeName}.</p>
      ) : (
        <ul className="space-y-1">
          {featured.map((key, i) => (
            <motion.li key={key} layout transition={{ duration: 0.16 }} className={ROW}>
              <span className="flex-1 truncate text-[12.5px] font-medium text-ink">{propertyLabel(key, fields)}</span>
              <IconButton size="sm" variant="ghost" icon={ArrowUp} label={`Move ${propertyLabel(key, fields)} up`}
                          disabled={i === 0} onClick={() => moveFeatured(key, -1)} />
              <IconButton size="sm" variant="ghost" icon={ArrowDown} label={`Move ${propertyLabel(key, fields)} down`}
                          disabled={i === featured.length - 1} onClick={() => moveFeatured(key, 1)} />
              <IconButton size="sm" variant="ghost" icon={X} label={`Stop featuring ${propertyLabel(key, fields)}`}
                          onClick={() => writeFeatured(featured.filter((k) => k !== key))} />
            </motion.li>
          ))}
        </ul>
      )}
      {addable.length > 0 && (
        <div className="mt-2 flex items-center gap-2">
          <select
            aria-label="Property to feature"
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-glass-border bg-canvas-elevated px-2.5 py-1.5 text-[12.5px] text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40"
          >
            <option value="">Choose a property…</option>
            {addable.map((k) => <option key={k} value={k}>{propertyLabel(k, fields)}</option>)}
          </select>
          <Button size="sm" variant="subtle" leftIcon={Plus} disabled={!adding}
                  onClick={() => { writeFeatured([...featured, adding]); setAdding('') }}>
            Feature
          </Button>
        </div>
      )}
    </motion.section>
  )
}
