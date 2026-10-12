/**
 * The guide's bold labels open styled callouts, like `**Note:**` does.
 *
 * Every task page leads with `> **Before you start:**` and recovers with
 * `> **If you don't see …:**`. Rendered as plain blockquotes they read as
 * quotations, and the page loses the cues that tell a reader what to have
 * ready and where to look when the screen doesn't match the steps.
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'

import { markdownComponents } from './MarkdownComponents'

function boxOf(md: string): HTMLElement | null {
  const { container } = render(<ReactMarkdown components={markdownComponents}>{md}</ReactMarkdown>)
  return container.querySelector('[role="note"]')
}

describe('guide callout labels', () => {
  it('styles "Before you start", "If …" and "Admins" labels as callouts', () => {
    expect(boxOf('> **Before you start:** You need an account.')?.className).toContain('border-indigo-500/30')
    expect(boxOf('> **If you don’t see Trace Lineage:** ask an administrator.')?.className).toContain('border-orange-500/30')
    expect(boxOf('> **Admins:** Tracing depends on a feature switch.')?.className).toContain('border-teal-500/30')
  })

  it('keeps the standard labels working', () => {
    expect(boxOf('> **Note:** Something to know.')?.className).toContain('border-sky-500/30')
    expect(boxOf('> [!TIP]\n> A shortcut.')?.className).toContain('border-emerald-500/30')
  })

  it('leaves quotations alone', () => {
    // Only a bold label counts: plain prose that happens to start with "If"
    // and contain a colon is a quotation, not a callout.
    expect(boxOf('> If it rains: stay in.')).toBeNull()
    expect(boxOf('> **Ingestion** is where sources connect.')).toBeNull()
  })
})
