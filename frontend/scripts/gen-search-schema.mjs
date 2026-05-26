#!/usr/bin/env node
/**
 * Generate TypeScript types from the SearchQuery JSON Schema.
 *
 * Reads the canonical schema artifact produced by the backend export
 * script (`python -m backend.scripts.export_search_schema`) and emits a
 * TypeScript declaration file the rest of the FE imports from.
 *
 * This is the cross-repo seam: in a polyrepo world the input file is
 * downloaded from the npm-published `@synodic/search-schema` package or
 * the versioned URL; in this worktree it's a relative path into the
 * backend tree.
 *
 *   Input  : ../backend/common/schema/searchquery.v1.json
 *   Output : src/types/generated/searchquery.ts
 *
 * Run manually:
 *   pnpm gen:search-schema
 *
 * Wired into `prebuild` so a fresh `pnpm build` always uses up-to-date
 * types — protects against accidental drift if a developer forgets to
 * regenerate after a model change.
 */
import { compile } from 'json-schema-to-typescript'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FE_ROOT = resolve(__dirname, '..')
const REPO_ROOT = resolve(FE_ROOT, '..')

// Resolve the canonical schema location relative to the repo root. The
// pretty (indented) JSON is what we compile; the .min.json is the
// source of truth for the export script's drift check.
const SCHEMA_PATH = resolve(REPO_ROOT, 'backend/common/schema/searchquery.v1.json')
const OUT_PATH = resolve(FE_ROOT, 'src/types/generated/searchquery.ts')

/**
 * Pre-codegen schema preprocessing.
 *
 * Two transforms — neither weakens the runtime contract (Ajv against
 * the unmodified schema still enforces these), only the TS *type
 * system* sees the relaxed shape:
 *
 * 1. Strip `minItems` / `maxItems` from arrays. Without this, bounded
 *    Pydantic lists like `Field(max_length=8)` become tuple-union
 *    types `[]|[T]|[T,T]|...|[T*8]` — unreadable + churn-magnet.
 *
 * 2. Collapse Pydantic `Any`-typed fields (which become `{}`-with-no-
 *    properties JSON Schema objects) to `true` so json-schema-to-
 *    typescript emits `unknown` instead of an opaque
 *    `interface ValueN { [k: string]: unknown }`. Those auto-named
 *    interfaces break callsites that pass primitives (the
 *    `PropertyPredicate.value` field is the canonical example).
 *
 * The original constraints stay in:
 *   - the Pydantic model (server-side validation)
 *   - the runtime schema endpoint (FE Ajv validation)
 *   - the export-script's `.min.json` (drift check)
 */
function relaxArrayBoundsForCodegen(node) {
    if (Array.isArray(node)) {
        node.forEach(relaxArrayBoundsForCodegen)
        return
    }
    if (node && typeof node === 'object') {
        if (node.type === 'array') {
            delete node.minItems
            delete node.maxItems
        }
        for (const key of Object.keys(node)) {
            relaxArrayBoundsForCodegen(node[key])
        }
    }
}

/**
 * Replace Pydantic Any-typed fields with `true` so the generator emits
 * `unknown`. A Pydantic ``Any`` (or untyped default) produces a JSON
 * Schema fragment that carries only meta keys (``title``, ``default``,
 * ``description``) — no constraint keys like ``type``, ``properties``,
 * ``items``, ``$ref``, ``enum``, ``const``, ``oneOf``, ``anyOf``,
 * ``allOf``. Detect that shape and collapse to ``true``.
 *
 * Recurses into the schema tree; mutates in place.
 */
const SCHEMA_CONSTRAINT_KEYS = new Set([
    'type', 'properties', 'items', '$ref', 'enum', 'const',
    'oneOf', 'anyOf', 'allOf', 'not', 'patternProperties',
    'additionalProperties', 'required', 'discriminator', 'pattern',
    'format',
])

function isAnyTypedFragment(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return false
    for (const k of Object.keys(node)) {
        if (SCHEMA_CONSTRAINT_KEYS.has(k)) return false
    }
    return true
}

/**
 * Walk a JSON Schema document and collapse Any-typed leaves only.
 *
 * "Schema position" = a node that JSON Schema interprets AS a schema
 * (vs. e.g. a map of named schemas like ``$defs`` or ``properties``).
 * We only collapse Any-typed fragments when we're standing in a
 * schema position; otherwise we'd accidentally turn the entire
 * document into ``true``.
 */
function walkSchemaPositions(schemaNode, onAnyTyped) {
    if (!schemaNode || typeof schemaNode !== 'object' || Array.isArray(schemaNode)) return

    // We're standing in a schema position. Check the Any-typed shape.
    if (isAnyTypedFragment(schemaNode)) {
        onAnyTyped(schemaNode)
        return
    }

    // Descend through the keys that nest other schemas. Each handled
    // differently depending on the JSON Schema convention.
    const schemaMap = ['properties', 'patternProperties', '$defs', 'definitions']
    for (const k of schemaMap) {
        if (schemaNode[k] && typeof schemaNode[k] === 'object') {
            for (const subKey of Object.keys(schemaNode[k])) {
                walkSchemaPositions(schemaNode[k][subKey], (anyTyped) => {
                    // Replace the child entry with `true`.
                    schemaNode[k][subKey] = true
                })
            }
        }
    }
    const schemaInline = ['items', 'additionalProperties', 'not', 'if', 'then', 'else']
    for (const k of schemaInline) {
        if (schemaNode[k] && typeof schemaNode[k] === 'object' && !Array.isArray(schemaNode[k])) {
            walkSchemaPositions(schemaNode[k], (anyTyped) => {
                schemaNode[k] = true
            })
        }
    }
    const schemaArray = ['oneOf', 'anyOf', 'allOf', 'prefixItems']
    for (const k of schemaArray) {
        if (Array.isArray(schemaNode[k])) {
            schemaNode[k].forEach((child, i) => {
                walkSchemaPositions(child, (anyTyped) => {
                    schemaNode[k][i] = true
                })
            })
        }
    }
}

function collapseAnyTypedToUnknown(rootSchema) {
    // Root must not be collapsed. Descend into its sub-positions.
    walkSchemaPositions(rootSchema, () => {
        // The root being Any-typed would be pathological; ignore.
    })
}

async function main() {
    const raw = readFileSync(SCHEMA_PATH, 'utf-8')
    const schema = JSON.parse(raw)
    relaxArrayBoundsForCodegen(schema)
    collapseAnyTypedToUnknown(schema)

    const banner = [
        '/**',
        ' * AUTO-GENERATED FROM THE SEARCHQUERY JSON SCHEMA — DO NOT EDIT BY HAND.',
        ' *',
        ` * Source : ${SCHEMA_PATH.replace(REPO_ROOT + '/', '')}`,
        ' * Tool   : json-schema-to-typescript via scripts/gen-search-schema.mjs',
        ' * Run    : `pnpm gen:search-schema` (from the frontend tree)',
        ' *',
        ' * Changes belong in the Pydantic model at',
        ' *   backend/common/models/search.py',
        ' * then re-run the backend export script:',
        ' *   python -m backend.scripts.export_search_schema',
        ' * and finally regenerate these types.',
        ' */',
    ].join('\n')

    const out = await compile(schema, 'SearchQuery', {
        bannerComment: banner,
        // The Pydantic schema already enforces tightness; we don't want
        // the generator to inject runtime `additionalProperties: false`
        // assumptions if the source schema doesn't say so explicitly.
        additionalProperties: false,
        // The schema uses both `$defs` (JSON Schema 2020-12) and inline
        // discriminated unions; the generator handles both.
        unreachableDefinitions: false,
        // Stable output: no timestamps / random ordering. Important for
        // diff review.
        declareExternallyReferenced: true,
        enableConstEnums: false,
        format: true,
        style: {
            singleQuote: true,
            tabWidth: 4,
            semi: false,
            printWidth: 100,
        },
    })

    mkdirSync(dirname(OUT_PATH), { recursive: true })
    writeFileSync(OUT_PATH, out, 'utf-8')

    const rel = OUT_PATH.replace(FE_ROOT + '/', '')
    console.log(`[gen:search-schema] wrote ${rel} (${out.length} bytes)`)
}

main().catch((err) => {
    console.error('[gen:search-schema] failed:', err)
    process.exit(1)
})
