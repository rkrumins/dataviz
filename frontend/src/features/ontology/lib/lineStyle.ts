/**
 * Which relationship types the canvas draws with the same kind of line.
 *
 * The canvas encodes an edge's type in two channels: its colour (`resolveEdgeColor`)
 * and its dash (`resolveEdgeStrokeStyle` → `edgeDashArray`). Two types that share a
 * stroke style are therefore separated by hue and nothing else — which is nothing at
 * all to a colour-blind reader, and nothing at all in a greyscale print of the canvas
 * that someone attached to a ticket.
 *
 * WIDTH IS DELIBERATELY NOT A CHANNEL HERE. The ontology declares `strokeWidth` and
 * the editor lets you set it, but it does not reach the canvas: `EdgeTypeDefinition`
 * carries colour, stroke style and animated only, and the overlay computes its own
 * widths from bundling and roll-up state. Counting width as a distinction would tell
 * an author two types are separable when the canvas draws them identically.
 */

export interface LineStyled {
  id: string
  name: string
  visual: {
    strokeColor: string
    strokeStyle: 'solid' | 'dashed' | 'dotted'
  }
}

/**
 * The other declared types this one shares a line style with, in the order they
 * were given. The subject is excluded by its own id, case-insensitively (`To` and
 * `TO` are one declared type — see `caseFold`), so editing a type never reports it
 * against itself.
 *
 * A twin that shares the colour too is still reported: the line is no more readable
 * for it, and the same fix — give one of them a different stroke style — applies.
 */
export function typesSharingLineStyle(subject: LineStyled, all: readonly LineStyled[]): LineStyled[] {
  const subjectId = (subject.id ?? '').trim().toLowerCase()
  return (all ?? []).filter(
    (other) =>
      (other.id ?? '').trim().toLowerCase() !== subjectId &&
      other.visual.strokeStyle === subject.visual.strokeStyle,
  )
}
