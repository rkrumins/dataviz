/**
 * reviewCsv — staged edits as CSV, for Review & Save's export (they exist only in the browser):
 * one row per thing changed, or one per field and property a change sends — built a few thousand
 * rows at a time, yielding between, so 50,000 changes export without freezing the page.
 */
import { csvLine } from '@/lib/csv'
import { fieldChanges, type ReviewGroup } from './reviewModel'

const KIND = { node: 'Entity', edge: 'Relationship', layout: 'View layout' } as const
const STATUS = { added: 'Added', modified: 'Edited', removed: 'Removed' } as const
const HEAD = ['Kind', 'Change', 'Type', 'Name', 'What it does', 'Changes', 'Id']
const FIELDS = ['Field', 'Folder', 'Before', 'After']
const BATCH = 2000

const yieldToPage = () => new Promise<void>((r) => setTimeout(r, 0))

export async function stagedCsvLines(groups: readonly ReviewGroup[], detail: 'changes' | 'properties'): Promise<string[]> {
  const lines = [csvLine(detail === 'properties' ? [...HEAD, ...FIELDS] : HEAD)]
  for (let i = 0; i < groups.length; i++) {
    if (i > 0 && i % BATCH === 0) await yieldToPage()
    const g = groups[i]
    const lead = [
      KIND[g.kind], g.kind === 'layout' ? '' : STATUS[g.status],
      g.kind === 'node' ? g.typeId : g.kind === 'edge' ? g.edgeType : '',
      g.kind === 'layout' ? '' : g.name,
      g.sentence.map((p) => (typeof p === 'string' ? p : p.name)).join(''),
      g.changes.length, g.key,
    ]
    if (detail === 'changes') { lines.push(csvLine(lead)); continue }
    let any = false
    for (const c of g.changes) {
      for (const f of fieldChanges(c)) {
        any = true
        lines.push(csvLine([...lead, f.label, f.folder ?? '', f.before, f.after]))
      }
    }
    if (!any) lines.push(csvLine([...lead, '', '', '', '']))
  }
  return lines
}
