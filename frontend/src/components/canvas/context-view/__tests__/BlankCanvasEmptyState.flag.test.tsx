/**
 * The canvas empty states, when version control is OFF.
 *
 * A blank model IS a versioned model — drafts and commits are all it is. With the feature
 * switched off it cannot be built at all: `ensureDraftOpen()` returns null and the server
 * refuses the writes. The guard is a correct BACKSTOP, but it is not a UI: it left a big
 * "Start building" button on screen that did precisely nothing when clicked, and explained
 * nothing about why. If it cannot be done, do not offer it — and say what is actually true.
 *
 * Also pinned here: "no permission" and "the feature is off" are DIFFERENT reasons to be
 * read-only, and telling someone the wrong one sends them to ask the wrong person.
 */
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/schema', () => ({
  useEntityTypes: () => [],
  useRootEntityTypes: () => [],
}))
vi.mock('@/features/ontology/components/DeclaredVsPhysical', () => ({
  DeclaredVsPhysical: () => null,
}))

import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { BlankCanvasEmptyState } from '../BlankCanvasEmptyState'

function setVersioning(on: boolean) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: on } })
}

function renderState(over: Partial<React.ComponentProps<typeof BlankCanvasEmptyState>> = {}) {
  return render(
    <BlankCanvasEmptyState
      modelName="Data Lineage"
      isDraft={false}
      canManage
      onAddEntity={vi.fn()}
      onStartBuilding={vi.fn()}
      {...over}
    />
  )
}

beforeEach(() => setVersioning(true))

describe('BlankCanvasEmptyState · versioningEnabled', () => {
  it('offers "Start building" to a manager when version control is on', () => {
    renderState()
    expect(screen.getByRole('button', { name: /Start building/ })).toBeInTheDocument()
    expect(screen.getByText(/Start building Data Lineage/)).toBeInTheDocument()
  })

  it('offers NOTHING to click when version control is off', () => {
    setVersioning(false)
    renderState()
    expect(screen.queryByRole('button', { name: /Start building/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Add your first entity/ })).not.toBeInTheDocument()
  })

  it('stops promising to build something it cannot build', () => {
    setVersioning(false)
    renderState()
    expect(screen.queryByText(/Start building Data Lineage/)).not.toBeInTheDocument()
    expect(screen.getByText(/Data Lineage is empty/)).toBeInTheDocument()
  })

  it('blames the feature, not the person — a permissions message would misdirect them', () => {
    setVersioning(false)
    renderState({ canManage: true })
    expect(screen.getByText(/Editing is turned off for this workspace/)).toBeInTheDocument()
    expect(screen.queryByText(/Someone with edit access/)).not.toBeInTheDocument()
  })

  it('still blames permissions when THAT is the real reason', () => {
    setVersioning(true)
    renderState({ canManage: false })
    expect(screen.getByText(/Someone with edit access/)).toBeInTheDocument()
  })

  it('does not offer "Add your first entity" even inside a stale draft', () => {
    setVersioning(false)
    renderState({ isDraft: true })
    expect(screen.queryByRole('button', { name: /Add your first entity/ })).not.toBeInTheDocument()
  })
})
