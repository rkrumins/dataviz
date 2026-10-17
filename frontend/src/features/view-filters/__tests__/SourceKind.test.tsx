/**
 * Versioned / External is a version-control surface: it follows the deployment's
 * Version control switch like every other one. Its menu works like the other
 * filters (picking the chosen kind again lets go), and a badge with no known kind
 * renders nothing rather than guessing.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { SourceKindMenu } from '../components/SourceKindMenu'
import { SourceKindBadge } from '../components/SourceKindBadge'

function versioning(on: boolean) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: on } })
}

afterEach(() => versioning(true))

describe('SourceKindMenu', () => {
  const trigger = () => screen.getByRole('button', { expanded: false })
  const option = (name: RegExp) => screen.getAllByRole('button', { name }).at(-1)!

  it('picks a kind, names it on the menu, and lets go when it is picked again', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<SourceKindMenu value={null} onChange={onChange} />)
    expect(trigger().textContent).toMatch(/Versioning/)
    await user.click(trigger())
    await user.click(option(/Versioned/))
    expect(onChange).toHaveBeenLastCalledWith('versioned')

    rerender(<SourceKindMenu value="versioned" onChange={onChange} />)
    expect(trigger().textContent).toMatch(/^Versioned/)
    await user.click(trigger())
    await user.click(option(/Versioned/))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('shows how many views each would leave, when known', async () => {
    const user = userEvent.setup()
    render(<SourceKindMenu value={null} onChange={() => {}} counts={{ versioned: 12, external: 3 }} />)
    await user.click(trigger())
    expect(option(/Versioned/).textContent).toMatch(/12$/)
    expect(option(/External/).textContent).toMatch(/3$/)
  })

  it('is hidden when version control is switched off', () => {
    versioning(false)
    const { container } = render(<SourceKindMenu value={null} onChange={() => {}} />)
    expect(container.textContent).toBe('')
  })
})

describe('SourceKindBadge', () => {
  it('names the kind', () => {
    render(<SourceKindBadge kind="external" />)
    expect(screen.getByText('External')).toBeTruthy()
  })

  it('renders nothing for an unknown kind, or with version control off', () => {
    const { container, rerender } = render(<SourceKindBadge kind={null} />)
    expect(container.textContent).toBe('')
    versioning(false)
    rerender(<SourceKindBadge kind="versioned" />)
    expect(container.textContent).toBe('')
  })
})
