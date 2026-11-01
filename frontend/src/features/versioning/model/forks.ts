/** A fork's data source is its graph's `dsfork_…` id, and nothing else has one: so a screen can tell a
 *  data source that may be a fork before it reads anything. `forkOf` on the data source says for sure. */
export const isForkDataSourceId = (id?: string | null): boolean => !!id && id.startsWith('dsfork_')
