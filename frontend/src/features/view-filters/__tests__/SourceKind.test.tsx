/**
 * Versioned / External is a version-control surface: it follows the deployment's
 * Version control switch like every other one. The pills toggle (pressing the
 * active one lets go), and a badge with no known kind renders nothing rather than
 * guessing.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_FEATURES, useFeaturesStore } from '@/store/features'
import { SourceKindToggle } from '../components/SourceKindToggle'
import { SourceKindBadge } from '../components/SourceKindBadge'

function versioning(on: boolean) {
  useFeaturesStore.setState({ values: { ...DEFAULT_FEATURES, versioningEnabled: on } })
}

afterEach(() => versioning(true))

describe('SourceKindToggle', () => {
  it('selects a kind, and lets go when the active pill is pressed again', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const { rerender } = render(<SourceKindToggle value={null} onChange={onChange} />)
    await user.click(screen.getByRole('button', { name: /Versioned/ }))
    expect(onChange).toHaveBeenLastCalledWith('versioned')

    rerender(<SourceKindToggle value="versioned" onChange={onChange} />)
    expect(screen.getByRole('button', { name: /Versioned/ }).getAttribute('aria-pressed')).toBe('true')
    await user.click(screen.getByRole('button', { name: /Versioned/ }))
    expect(onChange).toHaveBeenLastCalledWith(null)
  })

  it('shows how many views each would leave, when known', () => {
    render(<SourceKindToggle value={null} onChange={() => {}} counts={{ versioned: 12, external: 3 }} />)
    expect(screen.getByRole('button', { name: /Versioned\s*12/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /External\s*3/ })).toBeTruthy()
  })

  it('is hidden when version control is switched off', () => {
    versioning(false)
    const { container } = render(<SourceKindToggle value={null} onChange={() => {}} />)
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
