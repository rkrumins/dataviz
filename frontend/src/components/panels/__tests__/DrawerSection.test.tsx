/**
 * Section — the entity drawer's titled block, and its disclosure.
 *
 * Contract: open by default, the whole title row toggles, an `action` is
 * not a toggle, and the choice is remembered so a deep entity doesn't have
 * to be re-folded on every visit.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { Section } from '../DrawerSection'
import { usePreferencesStore } from '@/store/preferences'

beforeEach(() => {
  usePreferencesStore.setState({ drawerSectionsCollapsed: {} })
})

describe('Section', () => {
  it('renders a plain header when it is not collapsible', () => {
    render(<Section title="Details"><p>body</p></Section>)

    expect(screen.getByText('Details')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('is open by default and says so', () => {
    render(
      <Section title="Relationship" collapsible sectionKey="relationship">
        <p>placement</p>
      </Section>,
    )

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('placement')).toBeInTheDocument()
  })

  it('folds the body away when the header is clicked, and back', async () => {
    const user = userEvent.setup()
    render(
      <Section title="Relationship" collapsible sectionKey="relationship">
        <p>placement</p>
      </Section>,
    )

    await user.click(screen.getByRole('button'))
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('placement')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button'))
    expect(screen.getByText('placement')).toBeInTheDocument()
  })

  it('remembers the choice across a remount', async () => {
    const user = userEvent.setup()
    const { unmount } = render(
      <Section title="Relationship" collapsible sectionKey="relationship">
        <p>placement</p>
      </Section>,
    )
    await user.click(screen.getByRole('button'))
    unmount()

    render(
      <Section title="Relationship" collapsible sectionKey="relationship">
        <p>placement</p>
      </Section>,
    )
    expect(screen.queryByText('placement')).not.toBeInTheDocument()
  })

  it('remembers each section separately', async () => {
    const user = userEvent.setup()
    render(
      <>
        <Section title="Relationship" collapsible sectionKey="relationship">
          <p>placement</p>
        </Section>
        <Section title="Properties" collapsible sectionKey="properties">
          <p>fields</p>
        </Section>
      </>,
    )

    await user.click(screen.getByRole('button', { name: /relationship/i }))
    expect(screen.queryByText('placement')).not.toBeInTheDocument()
    expect(screen.getByText('fields')).toBeInTheDocument()
  })

  it('keeps an action out of the toggle — an action is not a disclosure', async () => {
    const user = userEvent.setup()
    render(
      <Section
        title="Relationship"
        collapsible
        sectionKey="relationship"
        action={<button type="button">Edit</button>}
      >
        <p>placement</p>
      </Section>,
    )

    await user.click(screen.getByRole('button', { name: 'Edit' }))
    expect(screen.getByText('placement')).toBeInTheDocument()
  })

  it('stays a plain header when it is collapsible but has nothing to remember by', () => {
    render(<Section title="Relationship" collapsible><p>placement</p></Section>)

    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('placement')).toBeInTheDocument()
  })
})
