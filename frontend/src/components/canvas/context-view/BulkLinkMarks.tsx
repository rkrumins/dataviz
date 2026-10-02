/**
 * BulkLinkMarks — marks the cards a bulk link is about on the canvas itself:
 * the other side the reader picked (a ring and a "Target" or "Source" pill),
 * and, mid-drag, the card under the pointer, ringed by what dropping there
 * would do — green when every pair links, amber when some do, red when none.
 *
 * A stylesheet keyed by card id rather than a prop on every row: the columns
 * are virtualized, so a row scrolled into view is marked the moment it mounts,
 * and marking touches no row's render.
 */
export interface BulkLinkMarksProps {
  picked: readonly string[]
  /** What the picked cards are to the selection. */
  pickedRole: 'Target' | 'Source'
  hover?: { id: string; level: 'all' | 'some' | 'none' } | null
}

const esc = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(`layer-node-${id}`) : `layer-node-${id}`)

const TONE = {
  all: 'rgb(var(--nx-lineage-out-rgb))',
  some: '#f59e0b',
  none: '#ef4444',
} as const

export function BulkLinkMarks({ picked, pickedRole, hover = null }: BulkLinkMarksProps) {
  if (picked.length === 0 && !hover) return null
  const rules: string[] = []
  if (picked.length > 0) {
    const sel = picked.map((id) => `#${esc(id)}`).join(',')
    const after = picked.map((id) => `#${esc(id)}::after`).join(',')
    rules.push(`${sel}{outline:2px solid rgb(var(--nx-lineage-out-rgb));outline-offset:-2px;border-radius:12px}`)
    rules.push(
      `${after}{content:"${pickedRole}";position:absolute;top:6px;right:10px;z-index:15;pointer-events:none;`
      + 'padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;line-height:16px;'
      + 'color:#fff;background:rgb(var(--nx-lineage-out-rgb))}',
    )
  }
  if (hover) {
    rules.push(`#${esc(hover.id)}{outline:2px solid ${TONE[hover.level]};outline-offset:-2px;border-radius:12px}`)
  }
  return <style data-bulk-link-marks>{rules.join('\n')}</style>
}
