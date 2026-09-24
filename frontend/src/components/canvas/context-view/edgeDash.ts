/** The one dash rule the canvas draws by: a roll-up is always dashed; every
 *  other line takes the ontology's own stroke style for its primary type. */
export function edgeDashArray(isRollup: boolean, strokeStyle?: 'solid' | 'dashed' | 'dotted'): string {
  if (isRollup) return '6 4'
  if (strokeStyle === 'dashed') return '6,3'
  if (strokeStyle === 'dotted') return '2,2'
  return 'none'
}

/** A VIRTUAL HOP's stitch: short dashes with round caps, for a line drawn over
 *  lineage steps the view leaves out. Distinct from every roll-up and ontology
 *  style above, and never a roll-up itself — so `lineDash` keeps it at every
 *  density, where a roll-up's dash is flattened on a busy board. */
export const VIRTUAL_HOP_DASH = '2 5'

/** A virtual hop's colour: the explore accent (`--nx-accent-explore`, one
 *  value in both themes). Hex, because the overlay derives arrow-marker ids
 *  and translucent tints from line colours. */
export const VIRTUAL_HOP_COLOR = '#06b6d4'
