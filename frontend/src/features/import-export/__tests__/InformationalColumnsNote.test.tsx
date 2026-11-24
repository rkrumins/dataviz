/**
 * InformationalColumnsNote pins:
 *   - a file that says where its rows sat (parent, path) is told, quietly, that those columns are
 *     skipped, counted as the file names them: a CSV's header in any case, an NDJSON's keys;
 *   - in plain words for the Business persona, the column names for the Technical one;
 *   - a file without them, and a workbook (which the server reads), say nothing: in every format,
 *     the same file with them and without differs by the note alone.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { usePersonaStore } from '@/store/persona'
import { InformationalColumnsNote, informationalColumnsOf } from '../InformationalColumnsNote'

const file = (name: string, body: string) => new File([body], name)

describe('informationalColumnsOf', () => {
  it('finds them in a header however it is written, and in a JSON record’s keys', async () => {
    expect(await informationalColumnsOf(file('t.csv', 'urn,name,Parent_Urn,path,owner\nu,n,p,a / b,o\n')))
      .toEqual(['Parent_Urn', 'path'])
    expect(await informationalColumnsOf(file('t.tsv', 'urn\tparentName\tpathUrns\nu\tp\ta; b\n')))
      .toEqual(['parentName', 'pathUrns'])
    expect(await informationalColumnsOf(file('t.ndjson', '{"kind": "node", "urn": "u", "parentType": "Table", "path": []}\n')))
      .toEqual(['parentType', 'path'])
    expect(await informationalColumnsOf(file('t.csv', 'urn,name,owner\n'))).toEqual([])
    expect(await informationalColumnsOf(file('t.xlsx', 'PK not really a workbook'))).toEqual([])
  })
})

describe('informationalColumnsOf: an export with them, and the same export without', () => {
  const placed = { kind: 'node', urn: 'u', parentUrn: 'p', parentName: 'P', parentType: 'Database', path: ['P'], pathUrns: ['p'] }
  const plain = { kind: 'node', urn: 'u' }
  const as = (format: string, row: Record<string, unknown>) => {
    if (format === 'ndjson') return `${JSON.stringify(row)}\n`
    if (format === 'json') return JSON.stringify([row])
    const sep = format === 'tsv' ? '\t' : ','
    return `${Object.keys(row).join(sep)}\n${Object.values(row).map((v) => (Array.isArray(v) ? v.join(' / ') : v)).join(sep)}\n`
  }

  it.each(['csv', 'tsv', 'ndjson', 'json'])('%s', async (format) => {
    expect(await informationalColumnsOf(file(`placed.${format}`, as(format, placed))))
      .toEqual(['parentUrn', 'parentName', 'parentType', 'path', 'pathUrns'])
    expect(await informationalColumnsOf(file(`plain.${format}`, as(format, plain)))).toEqual([])
  })
})

describe('InformationalColumnsNote', () => {
  const placed = file('trace.csv', 'urn,name,type,parentUrn,parentName,parentType,path,pathUrns\n')

  it('says in plain words that the parent and path columns are skipped', async () => {
    usePersonaStore.setState({ mode: 'business' })
    render(<InformationalColumnsNote files={[placed]} />)
    const note = await screen.findByRole('note', { name: 'Columns the import skips' })
    expect(note).toHaveTextContent('5 informational columns (parent, path) will be skipped.')
  })

  it('names the columns for the Technical persona', async () => {
    render(<InformationalColumnsNote files={[placed]} />)
    expect(await screen.findByRole('note')).toHaveTextContent(
      '5 informational columns (parentUrn, parentName, parentType, path, pathUrns) will be skipped.')
  })

  it('says nothing of a file without them', async () => {
    render(<InformationalColumnsNote files={[file('things.csv', 'key,type,name\n')]} />)
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
  })
})
