/**
 * The first-page auto-load rule, on its own.
 *
 * `ContextViewCanvas` auto-loads page 1 for a node that is expanded but holds
 * no children — the per-view expanded-state restore replays a saved expansion
 * set onto a canvas that has only roots, and without this those containers
 * render as an open box with nothing in it.
 *
 * It lived as four `continue`s inside an effect, which meant the only way to
 * ask "would this node be paged?" was to mount the whole canvas. Nothing
 * pinned it, and a reveal that depends on it saying NO could not say so in a
 * test. It is a pure function now.
 *
 * The reveal's own levels are marked handled as they open (`autoLoaded`), so
 * the promise "a revealed level does not fetch a page" is stated by the
 * reveal rather than inferred from a containment map that happens to be
 * populated.
 */
import { describe, it, expect } from 'vitest'

import { shouldAutoLoadFirstPage } from '../autoLoadFirstPage'
import type { HierarchyNode } from '../types'

const P = 'urn:demo:table:P'
const CHILD = 'urn:demo:column:C'

function container(childCount: number): HierarchyNode {
  return {
    id: P, urn: P, typeId: 'table', name: 'P', children: [],
    data: { label: 'P', urn: P, type: 'table', childCount },
    depth: 0, entityTypeOption: 'table', tags: [],
  }
}

function ask(over: {
  displayMap?: Map<string, HierarchyNode>
  childMap?: Map<string, string[]>
  autoLoaded?: Set<string>
} = {}) {
  return shouldAutoLoadFirstPage({
    nodeId: P,
    displayMap: over.displayMap ?? new Map([[P, container(150)]]),
    childMap: over.childMap ?? new Map(),
    autoLoaded: over.autoLoaded ?? new Set(),
  })
}

describe('shouldAutoLoadFirstPage', () => {
  it('pages an expanded container that has nothing under it', () => {
    expect(ask()).toBe(true)
  })

  // THE reveal's promise, stated where it can be read: a level the walk
  // opened has been accounted for, and nothing pages it afterwards.
  it('never pages a level the reveal has already accounted for', () => {
    expect(ask({ autoLoaded: new Set([P]) })).toBe(false)
  })

  it('leaves a container that already holds children to its Load-more row', () => {
    expect(ask({ childMap: new Map([[P, [CHILD]]]) })).toBe(false)
  })

  it('says nothing about a node the canvas is not drawing', () => {
    expect(ask({ displayMap: new Map() })).toBe(false)
  })

  it('leaves a childless container alone — there is no page to fetch', () => {
    expect(ask({ displayMap: new Map([[P, container(0)]]) })).toBe(false)
  })
})
