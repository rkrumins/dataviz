/**
 * ONE TOOLTIP SYSTEM, on the surfaces a person actually works in.
 *
 * The view page's header, the Context View toolbar and the versioning chrome
 * had FOUR ways of explaining a control at once: `HoverTip`, the native
 * `title` attribute, a hand-rolled `group-hover` card in CanvasVersioningBar,
 * and SVG `<title>` inside the usage sparkline. Four adjacent buttons in the
 * page header spoke two of them — Share as a designed card, Details, Activity
 * and Reviews as one-second OS pills — which is what "the tooltips are all
 * over the place" meant.
 *
 * A `title` on a control is not just an inconsistent look. It IS the
 * accessible name when nothing else provides one, so every conversion has to
 * hand that back as an explicit `aria-label` — and this guard is the thing
 * that notices when someone adds a new button with a `title` and no name.
 *
 * SOURCE-LEVEL ON PURPOSE. jsdom implements no native tooltip: there is no
 * rendering to assert on, no delay to wait out, and `toHaveAttribute('title')`
 * passes whether or not the browser would ever show it. A sweep over the text
 * is the honest tool here, the same way `noStrandedPortalOverlays` proves a
 * shape no test can reproduce.
 *
 * THE ONE SHAPE `title` SURVIVES ON: a NON-INTERACTIVE text node that
 * `truncate`s, where the tip's text IS the full value of that node. A proper
 * noun cut off mid-word with no way to read it is the case the attribute was
 * invented for. Everything else is a HoverTip.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '..')

/**
 * The surfaces this rule is enforced over: the view page's identity bar and
 * its two panels, the Context View toolbar, and the versioning chrome.
 *
 * DELIBERATELY NOT "every tree these live in". `components/views` also holds
 * the view wizard and the layer studio, and `context-view` also holds the
 * canvas body, the Lineage Lens and the connections panel — together well over
 * a hundred more `title`s that nobody has been through. Widening this list is
 * the right next move; widening it WITHOUT converting them would mean adding
 * a hundred allow-list entries, and an allow-list that long is not a guard.
 */
const SCOPE = [
  'components/views/ViewPageHeader.tsx',
  'components/views/ViewUsageBadge.tsx',
  'components/views/ViewBuiltOn.tsx',
  'components/views/EditDetailsPanel.tsx',
  'components/canvas/context-view/ContextViewHeader.tsx',
  'components/canvas/context-view/header',
  'components/canvas/property-manager/PropertyManagerButton.tsx',
  'features/versioning/components',
]

/**
 * Controls that keep a native `title` on purpose. Keep this list short and
 * give the reason: loosening the rule below instead would blind the guard for
 * every other control in three trees.
 */
const ALLOWED = new Map<string, string>([
  // (empty — every interactive `title` in scope was converted. A new entry
  // here needs a reason that survives being read out loud.)
])

const HOW_TO_FIX =
  'Wrap the control in <HoverTip label="…"> instead of giving it a `title`. '
  + 'Say what the control DOES, active voice, one sentence, sentence case, no '
  + 'trailing full stop — and add something the label does not already say. '
  + 'If the `title` was the control\'s only accessible name (an icon-only '
  + 'button), add an explicit `aria-label` in the SAME edit, or the conversion '
  + 'is an accessibility regression. See ViewPageHeader.tsx for the shape.'

function tsxFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...tsxFiles(path))
    } else if (entry.name.endsWith('.tsx')) {
      out.push(path)
    }
  }
  return out
}

/**
 * Every JSX opening tag in a source file. `{…}` expressions are kept whole, so
 * an arrow function's `=>` inside a prop cannot end a tag early and hide the
 * attribute that follows it. (Same scanner as `noStrandedPortalOverlays`.)
 */
function openingTags(src: string): string[] {
  const tags: string[] = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '<' || !/[A-Za-z]/.test(src[i + 1] ?? '')) continue
    let depth = 0
    let quote: string | null = null
    for (let j = i + 1; j < src.length; j++) {
      const c = src[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'" || c === '`') {
        quote = c
      } else if (c === '{') {
        depth++
      } else if (c === '}') {
        depth--
      } else if (depth === 0 && (c === '>' || c === '<')) {
        if (c === '>') tags.push(src.slice(i, j + 1))
        i = j - 1
        break
      }
    }
  }
  return tags
}

/** The tag's element name — lowercase for a DOM element, capitalised for a
 *  component. `title` on a COMPONENT is a prop, not the HTML attribute. */
function tagName(tag: string): string {
  return /^<([A-Za-z][\w.]*)/.exec(tag)?.[1] ?? ''
}

const INTERACTIVE_ROLES = [
  'button', 'link', 'option', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'tab', 'switch', 'checkbox', 'radio',
]

/**
 * A control: something a person clicks, or that the accessibility tree
 * announces as clickable. `<select>` and `<input>` are here too — their
 * `title` is likewise the accessible name when no label points at them.
 */
function isInteractive(tag: string): boolean {
  const name = tagName(tag)
  if (['button', 'a', 'select', 'input', 'textarea', 'summary'].includes(name)) return true
  if (name !== name.toLowerCase()) return false          // a component, not an element
  const role = /\brole="([a-z]+)"/.exec(tag)?.[1]
  if (role && INTERACTIVE_ROLES.includes(role)) return true
  return /\bonClick=/.test(tag)
}

/** The HTML attribute, not a `title` PROP passed to a component. */
function hasTitleAttribute(tag: string): boolean {
  return /\btitle=/.test(tag)
}

const sources = SCOPE.flatMap((entry) => {
  const path = join(SRC, entry)
  const files = entry.endsWith('.tsx') ? [path] : tsxFiles(path)
  return files.map((file) => ({
    rel: relative(SRC, file),
    src: readFileSync(file, 'utf8'),
  }))
})

describe('one tooltip system on the view page, the canvas toolbar and the versioning chrome', () => {
  // A guard that scans nothing passes forever.
  it('the sweep actually reaches the surfaces in the complaint', () => {
    expect(sources.length).toBeGreaterThan(30)
    const scanned = sources.map((s) => s.rel)
    for (const known of [
      'components/views/ViewPageHeader.tsx',
      'components/views/ViewUsageBadge.tsx',
      'components/canvas/context-view/ContextViewHeader.tsx',
      'components/canvas/context-view/header/ViewerActions.tsx',
      'components/canvas/context-view/header/HeaderSearch.tsx',
      'features/versioning/components/CanvasVersioningBar.tsx',
      'features/versioning/components/BranchSwitcher.tsx',
    ]) {
      expect(scanned).toContain(known)
    }
  })

  it('no interactive control explains itself with a native title', () => {
    const offenders: string[] = []
    for (const { rel, src } of sources) {
      if (ALLOWED.has(rel)) continue
      for (const tag of openingTags(src)) {
        if (!isInteractive(tag) || !hasTitleAttribute(tag)) continue
        offenders.push(`${rel} — ${tag.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    expect(offenders, HOW_TO_FIX).toEqual([])
  })

  it('the surviving titles are all truncated text nodes, which is the exception', () => {
    // Stated as an assertion rather than a comment so the exception cannot
    // quietly widen: everything left carries `truncate`, so its tip is the
    // full value of a node the layout is cutting off.
    const survivors: string[] = []
    for (const { rel, src } of sources) {
      for (const tag of openingTags(src)) {
        if (!hasTitleAttribute(tag)) continue
        if (tagName(tag) !== tagName(tag).toLowerCase()) continue   // component prop
        if (/\btruncate\b/.test(tag) || /\bmax-w-\[/.test(tag)) continue
        survivors.push(`${rel} — ${tag.replace(/\s+/g, ' ').slice(0, 120)}`)
      }
    }
    expect(
      survivors,
      '`title` survives on exactly one shape: a non-interactive text node that '
      + 'truncates, where the tip IS the full value. Anything else is a HoverTip.',
    ).toEqual([])
  })

  it('nobody has hand-rolled a second tooltip', () => {
    // CanvasVersioningBar carried the app's only bespoke hover card — a
    // `group-hover` panel with no delay, clipped by its ancestors, firing at
    // the same time as a native `title` on the same button. It is one
    // HoverTip now; `label` takes a node precisely so a legend needs no
    // second component.
    for (const { rel, src } of sources) {
      expect(src, `${rel}: ${HOW_TO_FIX}`).not.toMatch(/group-hover:visible/)
    }
  })

  it('every converted control in the header row still has an accessible name', () => {
    // The regression a `title`-to-HoverTip sweep invites: `title` was the
    // accessible name of every icon-only button in these clusters, and a
    // sighted-only tooltip is a downgrade, not a fix.
    const header = sources.find((s) => s.rel === 'components/views/ViewPageHeader.tsx')!.src
    for (const name of ['"Details"', '"Activity"', 'Publication requested — open sharing']) {
      expect(header, `ViewPageHeader lost the aria-label for ${name}`).toContain(`aria-label=`)
      expect(header).toContain(name)
    }
    const bar = sources.find((s) => s.rel === 'features/versioning/components/CanvasVersioningBar.tsx')!.src
    expect(bar, 'the icon-only Discard control must keep a name').toContain('aria-label="Discard draft"')
  })
})
