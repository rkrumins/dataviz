/**
 * Why a change to a data model of one's own was refused (`POST /playground/layers…`), in words
 * a person can act on.
 */
export function layerRefusal(e: unknown): string {
    const { detail } = (e ?? {}) as { detail?: { type?: string } }
    switch (detail?.type) {
        case 'layer_quota': return 'You’ve made all the data models you may keep — delete one you’re done with, then try again.'
        case 'feature_disabled': return 'Data models of your own are turned off right now. An administrator turns them on with the Playground switch.'
        case 'playground_not_member': return 'Join the Playground first — open it from the sidebar — then try again.'
        case 'layer_not_yours': return 'Only the person who made this data model can change it.'
        case 'unknown_ontology': return 'That data model isn’t there any more — it may have been deleted.'
        case 'ontology_not_offered': return 'That data model isn’t one you can use here.'
    }
    return (e instanceof Error && e.message) || 'That didn’t work just now. Try again in a moment.'
}
