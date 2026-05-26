/**
 * Minimal JSON Schema 2020-12 document shape — enough to drive the
 * Ajv validator and to surface a few well-known fields the FE reads
 * directly (e.g. ``properties.$schemaVersion.const``).
 *
 * We do NOT pull a full JSON Schema typings library; the schema served
 * by `/search/schema` is produced by Pydantic and conforms to JSON
 * Schema 2020-12, but the FE only inspects a handful of fields. Anything
 * not covered here is reachable via the index signature.
 */

/**
 * Version of the SearchQuery contract the FE was compiled against.
 *
 * Today this is a worktree-local constant. When the schema is published
 * as an npm artifact (`@synodic/search-schema`), this becomes
 * ``import { SCHEMA_VERSION } from '@synodic/search-schema'``. The
 * useSearchSchema hook asserts the served version matches this and
 * fails loud on mismatch.
 */
export const EXPECTED_SCHEMA_VERSION = '1'

export interface JsonSchemaDocument {
    $schema?: string
    $id?: string
    $ref?: string
    $defs?: Record<string, JsonSchemaDocument>
    /** Pydantic v1-style definitions; older schemas may emit this name instead of `$defs`. */
    definitions?: Record<string, JsonSchemaDocument>
    type?: string | string[]
    title?: string
    description?: string
    properties?: Record<string, JsonSchemaDocument>
    required?: string[]
    items?: JsonSchemaDocument
    additionalProperties?: boolean | JsonSchemaDocument
    const?: unknown
    enum?: unknown[]
    oneOf?: JsonSchemaDocument[]
    anyOf?: JsonSchemaDocument[]
    allOf?: JsonSchemaDocument[]
    not?: JsonSchemaDocument
    default?: unknown
    /** Escape hatch for fields not modelled above. */
    [key: string]: unknown
}

/**
 * Extract the wire-format schema version a `/search/schema` document
 * declares. Returns ``null`` when the version field is missing or not a
 * string-const — the caller decides whether that's a fatal error.
 *
 * The version lives at ``properties.$schemaVersion.const`` because the
 * Pydantic model declares it as ``Literal["1"]`` with alias
 * ``$schemaVersion`` — JSON Schema 2020-12 represents that as a
 * single-value ``const``.
 */
export function readSchemaVersion(schema: JsonSchemaDocument): string | null {
    const versionProp = schema.properties?.['$schemaVersion']
    if (!versionProp) return null
    const constValue = versionProp.const
    if (typeof constValue === 'string') return constValue
    if (Array.isArray(versionProp.enum) && versionProp.enum.length === 1 && typeof versionProp.enum[0] === 'string') {
        return versionProp.enum[0]
    }
    return null
}
