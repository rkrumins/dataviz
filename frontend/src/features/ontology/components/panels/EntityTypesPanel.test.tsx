/**
 * EntityTypesPanel — validation attribution.
 *
 * Issues carrying the backend's structured `affected` type id must attach to
 * exactly that type's row; issues without it fall back to the legacy
 * message-substring heuristic.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EntityTypesPanel } from './EntityTypesPanel'
import type { EntityTypeSchema } from '@/types/schema'

function makeType(id: string, name: string): EntityTypeSchema {
  return {
    id,
    name,
    pluralName: `${name}s`,
    description: '',
    visual: { icon: 'Box', color: '#6366f1', shape: 'rounded', size: 'md', borderStyle: 'solid', showInMinimap: true },
    hierarchy: { level: 0, canContain: [], canBeContainedBy: [], defaultExpanded: false, rollUpFields: [] },
    behavior: { selectable: true, draggable: true, expandable: true, traceable: true, clickAction: 'select', doubleClickAction: 'expand', expansionMode: 'graph' },
    fields: [],
  } as unknown as EntityTypeSchema
}

const noop = () => {}

function renderPanel(issues: Array<{ severity: string; message: string; code?: string; affected?: string }>) {
  return render(
    <EntityTypesPanel
      entityTypes={[makeType('Server', 'Server'), makeType('Rack', 'Rack')]}
      entityStatMap={new Map()}
      isLocked={false}
      search=""
      validationResult={{ isValid: false, issues }}
      editorPanel={null}
      onSearch={noop}
      onEdit={noop}
      onNew={noop}
      onDelete={noop}
      onDismissValidation={noop}
    />,
  )
}

describe('EntityTypesPanel validation attribution', () => {
  it('attaches issues to the row named by the structured affected id only', () => {
    renderPanel([
      // The message mentions BOTH type names — structured attribution must win
      // over the substring heuristic, pinning it to Server only.
      { severity: 'error', message: 'Server conflicts with Rack', code: 'X', affected: 'Server' },
    ])
    const serverRow = document.getElementById('entity-type-row-Server')!
    const rackRow = document.getElementById('entity-type-row-Rack')!
    expect(serverRow.textContent).toContain('Server conflicts with Rack')
    expect(rackRow.textContent).not.toContain('Server conflicts with Rack')
  })

  it('falls back to substring matching when affected is absent', () => {
    renderPanel([
      { severity: 'warning', message: "Entity type 'Rack' has no name." },
    ])
    const rackRow = document.getElementById('entity-type-row-Rack')!
    expect(rackRow.textContent).toContain("has no name")
  })

  it('renders clickable per-type chips in the banner', () => {
    renderPanel([
      { severity: 'error', message: 'broken', affected: 'Server' },
    ])
    expect(screen.getByRole('button', { name: /Server\s*1/ })).toBeInTheDocument()
  })
})
