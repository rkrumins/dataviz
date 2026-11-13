/**
 * What an import's rows find their items by — its `identifier`: `entity_id`, `urn`, `prop.<name>`
 * (a property such as `external_id`), or `prop.<name>,urn` (the property, then the urn: a row
 * without the property is found by its urn). Whichever it is, an item's id never changes.
 */

export type MatchKind = 'entity_id' | 'urn' | 'prop'

export interface Match {
  kind: MatchKind
  /** The property's name, when `kind` is `prop`. */
  name: string
  /** With `prop`: a row that doesn't carry it is found by its urn (`prop.<name>,urn`). */
  orUrn?: boolean
}

const OR_URN = ',urn'

export function parseIdentifier(identifier: string): Match {
  if (identifier.startsWith('prop.')) {
    const rest = identifier.slice('prop.'.length)
    const orUrn = rest.endsWith(OR_URN)
    return { kind: 'prop', name: orUrn ? rest.slice(0, -OR_URN.length) : rest, orUrn }
  }
  return { kind: identifier === 'urn' ? 'urn' : 'entity_id', name: '' }
}

export function formatIdentifier(match: Match): string {
  return match.kind === 'prop' ? `prop.${match.name.trim()}${match.orUrn ? OR_URN : ''}` : match.kind
}

/** "Entity ID", "URN", "Property external_id", or "Property external_id, then URN". */
export function identifierLabel(identifier: string): string {
  const { kind, name, orUrn } = parseIdentifier(identifier)
  return kind === 'prop' ? `Property ${name}${orUrn ? ', then URN' : ''}` : kind === 'urn' ? 'URN' : 'Entity ID'
}

export const MATCH_KINDS: Array<{ kind: MatchKind; label: string; help: string }> = [
  { kind: 'entity_id', label: 'Entity ID',
    help: 'A row’s entity_id finds its item; a row without one is found by its urn. Matched items keep '
      + 'their ids and history; new ones get new ids.' },
  { kind: 'urn', label: 'URN',
    help: 'A row is found by its urn alone (or by an entity_id of this graph). Matched items keep their '
      + 'ids and history; a row with no urn is refused.' },
  { kind: 'prop', label: 'A property',
    help: 'A row is found by its value of a property, such as the id it has in the system it came '
      + 'from. Matched items keep their ids and history; only the columns a row carries change.' },
]
