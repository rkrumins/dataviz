/**
 * A remembered concept, as people read it. The assistant stores the type property a person
 * confirmed (“which property says what kind of thing each one is”) as the concept `entitytype`;
 * everything else is the person's own word, shown as they wrote it.
 */
const NAMES: Record<string, string> = { entitytype: 'Entity type', 'entity type': 'Entity type' }

export function conceptName(concept: string): string {
    return NAMES[concept.trim().toLowerCase()] ?? concept
}
