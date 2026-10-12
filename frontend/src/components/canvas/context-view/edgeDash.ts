/** The one dash rule the canvas draws by: a roll-up is always dashed; every
 *  other line takes the ontology's own stroke style for its primary type. */
export function edgeDashArray(isRollup: boolean, strokeStyle?: 'solid' | 'dashed' | 'dotted'): string {
  if (isRollup) return '6 4'
  if (strokeStyle === 'dashed') return '6,3'
  if (strokeStyle === 'dotted') return '2,2'
  return 'none'
}
