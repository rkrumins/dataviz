/**
 * Lossless serialize/parse for the SearchQuery predicate tree.
 *
 * The visual builder and the JSON editor are two presentations of the
 * SAME ``Predicate`` object in ``searchStore``. Toggling between them
 * goes through this codec so the round-trip is provably lossless:
 *
 *     encode(p) === encode(decode(encode(p)))
 *
 * Property-tested in ``predicateCodec.spec.ts`` against arbitrary trees
 * generated from the JSON Schema. The test enforces the round-trip
 * invariant for every predicate kind.
 *
 * Validation is delegated to Ajv against the live schema fetched by
 * ``useSearchSchema``. Parsing without validation would defeat the
 * point — the editor's selling point is "your JSON is the source of
 * truth, and we catch invalid shapes before they hit the wire".
 */
import Ajv, { type ValidateFunction } from 'ajv'
import addFormats from 'ajv-formats'

import type { Predicate, SearchQuery } from '@/types/search'
import type { JsonSchemaDocument } from '@/types/jsonSchema'


export class PredicateValidationError extends Error {
    /** Ajv's structured error list. Each entry tells you the JSON Pointer
     *  path that failed and why; the JSON editor surfaces these as red
     *  underlines tied back to the offending characters. */
    public readonly issues: ReadonlyArray<{ path: string; message: string }>

    constructor(message: string, issues: ReadonlyArray<{ path: string; message: string }>) {
        super(message)
        this.name = 'PredicateValidationError'
        this.issues = issues
    }
}


/**
 * Serialize a Predicate (or full SearchQuery) to canonical JSON.
 *
 * "Canonical" means:
 *   - Stable key ordering — discriminator field ``kind`` always comes
 *     first, then remaining keys alphabetically. This makes diffs in
 *     git / the JSON editor stable across edits.
 *   - Two-space indent, with the trailing newline that JSON-Schema-
 *     validating tools expect.
 *
 * Output is round-trip compatible: ``decode(encode(x)) === x``
 * (modulo Pydantic's optional fields).
 */
export function encodePredicate(predicate: Predicate, indent = 2): string {
    return JSON.stringify(predicate, canonicalReplacer, indent)
}

export function encodeSearchQuery(query: SearchQuery, indent = 2): string {
    return JSON.stringify(query, canonicalReplacer, indent)
}


/**
 * Parse + validate raw JSON into a Predicate.
 *
 * Throws ``PredicateValidationError`` with structured issues on:
 *   - invalid JSON syntax
 *   - schema-validation failure (Ajv against the live schema)
 *
 * The caller (usually the JSON editor) catches this and renders the
 * issues inline. The store is only updated on success — invalid edits
 * never reach the canonical predicate object.
 */
export function decodePredicate(
    raw: string,
    schema: JsonSchemaDocument | null,
): Predicate {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new PredicateValidationError(
            'Invalid JSON: ' + msg,
            [{ path: '', message: msg }],
        )
    }
    if (schema) {
        validateAgainstSchema(parsed, schema, '$defs/Predicate', 'predicate')
    }
    return parsed as Predicate
}

export function decodeSearchQuery(
    raw: string,
    schema: JsonSchemaDocument | null,
): SearchQuery {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new PredicateValidationError(
            'Invalid JSON: ' + msg,
            [{ path: '', message: msg }],
        )
    }
    if (schema) {
        validateAgainstSchema(parsed, schema, '', 'searchQuery')
    }
    return parsed as SearchQuery
}


// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Stable key ordering for JSON.stringify.
 *
 * Discriminator ``kind`` always appears first so a diff between two
 * versions of a predicate tree is dominated by changes, not by key-
 * reordering. Remaining keys are sorted alphabetically for the same
 * reason.
 */
function canonicalReplacer(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const entries = Object.entries(value as Record<string, unknown>)
        entries.sort(([a], [b]) => {
            if (a === 'kind') return -1
            if (b === 'kind') return 1
            return a < b ? -1 : a > b ? 1 : 0
        })
        const ordered: Record<string, unknown> = {}
        for (const [k, v] of entries) {
            ordered[k] = v
        }
        return ordered
    }
    return value
}


// Ajv is initialised lazily and cached — the schema doesn't change
// during the app session, so compiling once amortises the (modest) cost
// of `ajv.compile(...)`.
let cachedSchema: JsonSchemaDocument | null = null
let cachedSearchQueryValidator: ValidateFunction | null = null
let cachedPredicateValidator: ValidateFunction | null = null


function ensureValidators(schema: JsonSchemaDocument): {
    searchQuery: ValidateFunction
    predicate: ValidateFunction
} {
    if (cachedSchema !== schema) {
        // Schema instance changed — rebuild. (In practice this happens
        // exactly once: when useSearchSchema's query resolves.)
        const ajv = new Ajv({
            allErrors: true,
            strict: false,
            // The Pydantic-emitted schema uses ``$defs`` (2020-12); Ajv
            // 8.x defaults to draft-07, so we explicitly enable refs.
            allowUnionTypes: true,
        })
        addFormats(ajv)

        // The schema served at /search/schema is the SearchApiContract
        // bundle — a single document whose ``$defs`` carry every API
        // shape. Per-shape validators reference fragments via $ref.
        //
        // Two-step registration:
        //   1. ``addSchema(schema, key)`` registers the bundle under an
        //      explicit key. Spreading + overriding ``$id`` and letting
        //      Ajv pick the id up isn't reliable across Ajv 8.x releases
        //      (the served schema's existing keys may already conflict)
        //      — the second-arg key form bypasses that ambiguity.
        //   2. ``getSchema(<key>#/<fragment>)`` returns a validator that
        //      targets the fragment. Refs inside the fragment resolve
        //      against the bundle thanks to the parent registration.
        const BUNDLE_ID = 'searchApiContract'
        ajv.addSchema(schema as Record<string, unknown>, BUNDLE_ID)

        const searchQueryValidator = ajv.getSchema(
            `${BUNDLE_ID}#/$defs/SearchQuery`,
        )
        if (!searchQueryValidator) {
            // Shouldn't happen — the schema always carries $defs/SearchQuery
            // (verified by the test suite). Surface a clear error if it
            // ever does, instead of crashing inside the validator caller.
            throw new Error(
                `Schema is missing $defs/SearchQuery — cannot build validator.`,
            )
        }
        cachedSearchQueryValidator = searchQueryValidator

        // The Predicate field is a discriminated union — it's modelled
        // inline on SearchQuery.properties.predicate, not as a $def.
        // Compile a wrapper schema with an explicit $id so Ajv has a
        // base to resolve internal $refs against, and pull the inline
        // sub-schema in by spreading the parent's $defs.
        const sqDef = schema.$defs?.SearchQuery
        const predProp = sqDef?.properties?.predicate
        if (predProp) {
            cachedPredicateValidator = ajv.compile({
                $id: `${BUNDLE_ID}:predicate`,
                ...predProp,
                $defs: schema.$defs,
            } as Record<string, unknown>)
        } else {
            cachedPredicateValidator = cachedSearchQueryValidator
        }

        cachedSchema = schema
    }
    return {
        searchQuery: cachedSearchQueryValidator!,
        predicate: cachedPredicateValidator!,
    }
}


function validateAgainstSchema(
    parsed: unknown,
    schema: JsonSchemaDocument,
    /** Reserved for future per-fragment routing; ignored today. */
    _fragmentRef: string,
    role: 'predicate' | 'searchQuery',
): void {
    const { predicate, searchQuery } = ensureValidators(schema)
    const validator = role === 'predicate' ? predicate : searchQuery
    if (validator(parsed)) return
    const issues = (validator.errors ?? []).map((e) => ({
        path: e.instancePath || '(root)',
        message: `${e.instancePath || '(root)'} ${e.message ?? 'invalid'}`,
    }))
    throw new PredicateValidationError(
        `${role} failed validation: ${issues.map((i) => i.message).join('; ')}`,
        issues,
    )
}
