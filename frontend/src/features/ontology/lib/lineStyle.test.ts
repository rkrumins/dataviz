/**
 * `typesSharingLineStyle` — which other relationship types the canvas draws with
 * the same kind of line, so colour is the only thing telling them apart.
 *
 * Live dev stack, 2026-08-30, the 11-type seeded ontology on ws_438429af72a9:
 * PRODUCES (#3b82f6), CONSUMES (#f59e0b), TRANSFORMS (#14b8a6) and AGGREGATED
 * (#22c55e) are all `solid`; DEFINED_BY (#a855f7) and TAGGED_WITH (#64748b) are
 * both `dotted`. Four solid lines and two dotted ones, separated by hue alone —
 * which is nothing at all to a colour-blind reader.
 */
import { describe, it, expect } from 'vitest'
import { typesSharingLineStyle, type LineStyled } from './lineStyle'

const t = (id: string, strokeStyle: LineStyled['visual']['strokeStyle'], strokeColor: string): LineStyled => ({
  id,
  name: id,
  visual: { strokeColor, strokeStyle },
})

const PRODUCES = t('PRODUCES', 'solid', '#3b82f6')
const CONSUMES = t('CONSUMES', 'solid', '#f59e0b')
const TRANSFORMS = t('TRANSFORMS', 'solid', '#14b8a6')
const DEPENDS_ON = t('DEPENDS_ON', 'dashed', '#ec4899')
const DEFINED_BY = t('DEFINED_BY', 'dotted', '#a855f7')
const TAGGED_WITH = t('TAGGED_WITH', 'dotted', '#64748b')

const ONTOLOGY = [PRODUCES, CONSUMES, TRANSFORMS, DEPENDS_ON, DEFINED_BY, TAGGED_WITH]

describe('typesSharingLineStyle', () => {
  it('names the other types drawn with the same line', () => {
    expect(typesSharingLineStyle(PRODUCES, ONTOLOGY).map(r => r.id)).toEqual(['CONSUMES', 'TRANSFORMS'])
    expect(typesSharingLineStyle(DEFINED_BY, ONTOLOGY).map(r => r.id)).toEqual(['TAGGED_WITH'])
  })

  it('is empty when this type is the only one drawn that way', () => {
    expect(typesSharingLineStyle(DEPENDS_ON, ONTOLOGY)).toEqual([])
  })

  it('never counts the subject as its own twin, whatever the id casing', () => {
    const lower = t('produces', 'solid', '#3b82f6')
    expect(typesSharingLineStyle(lower, ONTOLOGY).map(r => r.id)).toEqual(['CONSUMES', 'TRANSFORMS'])
  })

  it('still reports a twin that shares the colour too — the line is no more readable for it', () => {
    const twin = t('EMITS', 'solid', PRODUCES.visual.strokeColor)
    expect(typesSharingLineStyle(PRODUCES, [PRODUCES, twin]).map(r => r.id)).toEqual(['EMITS'])
  })

  it('preserves the ontology order and tolerates an empty list', () => {
    expect(typesSharingLineStyle(PRODUCES, [])).toEqual([])
    expect(typesSharingLineStyle(TRANSFORMS, ONTOLOGY).map(r => r.id)).toEqual(['PRODUCES', 'CONSUMES'])
  })
})
