import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { changeListExportUrl } from '@/services/versioningApiService'
import { ExportMenu } from '../ExportMenu'

describe('ExportMenu', () => {
  it('offers both files, saying what each holds, and closes on a pick or Esc', () => {
    const onExport = vi.fn()
    render(<ExportMenu onExport={onExport} count={1234} />)
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
    expect(screen.getByText('1,234 changes, as filtered')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Property by property/ }))
    expect(onExport).toHaveBeenCalledWith('properties')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }))
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('asks the server for the list as filtered', () => {
    expect(changeListExportUrl('ws1', 'g1', { branchId: 'br1' }, { kind: 'node', statuses: ['added', 'modified'], q: ' ord ' }, 'properties'))
      .toBe('/api/v1/ws1/versioning/graphs/g1/diff/export.csv?branchId=br1&kind=node&status=added%2Cmodified&q=ord&detail=properties')
  })
})
