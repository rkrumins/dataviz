/** Dispatched on `window` by "Free memory" (the memory gauge): every cache
 *  that can be rebuilt from the server listens and lets go. Its own module,
 *  free of imports, so a hook can listen without pulling in the providers. */
export const RELEASE_MEMORY_EVENT = 'nx:release-memory'
