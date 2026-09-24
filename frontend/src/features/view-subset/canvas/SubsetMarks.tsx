/**
 * SubsetMarks — marks every picked card on the source canvas: a ring in the
 * explore accent and a pill saying how it came in (picked, grown upstream or
 * downstream, or on the path of a virtual hop).
 *
 * A stylesheet keyed by card id rather than a prop on every row, as
 * BulkLinkMarks does it: the columns are virtualized, so a row scrolled into
 * view is marked the moment it mounts, and marking touches no row's render.
 */
import type { SubsetPick, PickOrigin } from '../model/studioStore'

const esc = (id: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(`layer-node-${id}`) : `layer-node-${id}`)

const PILL: Record<PickOrigin, string> = {
  picked: 'Kept',
  'grown-up': '↑ Upstream',
  'grown-down': '↓ Downstream',
  path: 'On the path',
  outside: 'Outside',
}

const ACCENT = 'rgb(var(--nx-accent-explore-rgb))'

export function SubsetMarks({ picksByRow }: { picksByRow: ReadonlyMap<string, SubsetPick> }) {
  if (picksByRow.size === 0) return null
  const byOrigin = new Map<PickOrigin, string[]>()
  picksByRow.forEach((pick, row) => {
    const list = byOrigin.get(pick.origin)
    if (list) list.push(row)
    else byOrigin.set(pick.origin, [row])
  })
  const rules: string[] = []
  const all = [...picksByRow.keys()].map(row => `#${esc(row)}`).join(',')
  rules.push(`${all}{outline:2px solid ${ACCENT};outline-offset:-2px;border-radius:12px}`)
  byOrigin.forEach((rows, origin) => {
    const after = rows.map(row => `#${esc(row)}::after`).join(',')
    rules.push(
      `${after}{content:"${PILL[origin]}";position:absolute;top:6px;right:10px;z-index:15;pointer-events:none;`
      + 'padding:1px 7px;border-radius:999px;font-size:10px;font-weight:600;line-height:16px;'
      + `color:#fff;background:${ACCENT}}`,
    )
  })
  return <style data-subset-marks>{rules.join('\n')}</style>
}
