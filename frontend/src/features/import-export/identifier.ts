/**
 * What an import's rows find their items by — its `identifier`: `entity_id`, `urn` or
 * `prop.<name>` (a property such as `external_id`). Whichever it is, an item's id never changes.
 */

export type MatchKind = 'entity_id' | 'urn' | 'prop'

export interface Match {
  kind: MatchKind
  /** The property's name, when `kind` is `prop`. */
  name: string
}

export function parseIdentifier(identifier: string): Match {
  if (identifier.startsWith('prop.')) return { kind: 'prop', name: identifier.slice('prop.'.length) }
  return { kind: identifier === 'urn' ? 'urn' : 'entity_id', name: '' }
}

export function formatIdentifier(match: Match): string {
  return match.kind === 'prop' ? `prop.${match.name.trim()}` : match.kind
}

/** "Entity ID", "URN", or "Property external_id". */
export function identifierLabel(identifier: string): string {
  const { kind, name } = parseIdentifier(identifier)
  return kind === 'prop' ? `Property ${name}` : kind === 'urn' ? 'URN' : 'Entity ID'
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
