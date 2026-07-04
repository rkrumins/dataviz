# Entity Type-Change — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the ontology-validated foundation for changing an entity's type in place — backend acceptance + validation of type changes, a verified persistence/projection round-trip, and a pure client-side planner (`typesValidForNode`, `planRetype`) — with no UI yet.

**Architecture:** A pure planner in `ontologyPreflightService` computes type-change validity and the cascade ripple, reusing the existing `deriveContainmentEdges`/`deriveConnectableEdges` helpers. Persistence rides the existing `POST /changes` draft-op path (`update_entity` already carries `entityType`). The backend `mutation_validator` flips from rejecting type changes to re-validating them against parent/children/edges/cycles. Backend is the authoritative save gate; the planner is the instant client preview.

**Tech Stack:** Python (FastAPI, pytest) backend; TypeScript (Vitest) frontend; existing ontology model (`hierarchy.canContain`/`canBeContainedBy`, relationship `sourceTypes`/`targetTypes`).

**Spec:** `docs/superpowers/specs/2026-07-04-entity-type-change-crud-design.md`

## Global Constraints

- Case-insensitive type/edge id comparison everywhere (reuse shipped `sameId`/`findEntityType` in `ontologyPreflightService.ts`; `.upper()` sets in backend `mutation_validator.py`).
- Fail-open when no ontology is active (match existing `validate_node_mutation` behavior).
- Planner functions are PURE — no React, no store imports; graph adjacency is passed in via a context object.
- Reuse `deriveContainmentEdges` and `deriveConnectableEdges` — do NOT re-derive endpoint logic. **Verify their CURRENT signatures in `ontologyPreflightService.ts` before calling** (a trailing optional `entityTypes` param was added to `deriveConnectableEdges` during the humanized-reasons work; confirm whether `deriveContainmentEdges` has it too, and pass args in the real order). The task code below assumes a trailing `entityTypes`; drop it if the real signature omits it — the tsc gate will catch a mismatch.
- Frontend baseline: `cd frontend && npx tsc -b --pretty false 2>&1 | grep -c "error TS"` must not rise; 2 named pre-existing vitest failures (`GraphProviderContext`, `RegistryConnections`) are the only allowed failures.
- Backend tests run per-file: `python3 -m pytest backend/tests/<file> -q`.
- Commit discipline: shared tree — stage only files named in the task; `git diff --cached` before commit; never bare `git stash`. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

### Task 1: Backend — allow & validate entity-type change in `mutation_validator`

**Files:**
- Modify: `backend/app/ontology/mutation_validator.py` (`validate_node_mutation`)
- Test: `backend/tests/test_mutation_validator.py`

**Interfaces:**
- Consumes: existing `validate_node_mutation(ontology, entity_type, node_urn=None, parent_entity_type=None, existing_entity_type=None, child_entity_types=None, ...)` — read the real current signature before editing; adapt param names to what exists.
- Produces: `validate_node_mutation` now ACCEPTS `entity_type != existing_entity_type` when the new type is a valid child of `parent_entity_type` (`can_be_contained_by`) AND can contain every type in `child_entity_types` (`can_contain`), case-insensitive; otherwise returns the existing failure shape with a plain-language reason. No new function.

- [ ] **Step 1: Read the current validator** — open `backend/app/ontology/mutation_validator.py`, find `validate_node_mutation`, and note (a) how `existing_entity_type` currently triggers "type changes disallowed", (b) the failure return shape, (c) whether `child_entity_types` (or equivalent) is already a param. If children aren't available to the function, add a `child_entity_types: Optional[List[str]] = None` param (callers pass `[]` for now; the create/edge callers are unaffected).

- [ ] **Step 2: Write the failing tests** (append to `test_mutation_validator.py`, mirror its existing fixture style):

```python
def test_type_change_to_valid_child_and_container_is_accepted():
    # dataset (child of container) -> container is valid: container canBeContainedBy dataPlatform, canContain dataset
    ont = _ontology_with(...)  # reuse the file's ontology builder
    res = validate_node_mutation(ont, entity_type="container", existing_entity_type="dataset",
                                 parent_entity_type="dataPlatform", child_entity_types=["column"])
    assert res.ok is True

def test_type_change_rejected_when_new_type_invalid_under_parent():
    ont = _ontology_with(...)
    res = validate_node_mutation(ont, entity_type="column", existing_entity_type="container",
                                 parent_entity_type="dataPlatform", child_entity_types=[])
    assert res.ok is False
    assert "can't" in res.reason.lower() or "cannot" in res.reason.lower()

def test_type_change_rejected_when_new_type_cannot_contain_existing_child():
    ont = _ontology_with(...)
    res = validate_node_mutation(ont, entity_type="column", existing_entity_type="container",
                                 parent_entity_type="dataset", child_entity_types=["dataset"])
    assert res.ok is False

def test_type_change_is_case_insensitive():
    ont = _ontology_with(...)
    res = validate_node_mutation(ont, entity_type="CONTAINER", existing_entity_type="DATASET",
                                 parent_entity_type="DATAPLATFORM", child_entity_types=["COLUMN"])
    assert res.ok is True

def test_no_ontology_fails_open_on_type_change():
    res = validate_node_mutation(_empty_ontology(), entity_type="x", existing_entity_type="y",
                                 parent_entity_type=None, child_entity_types=[])
    assert res.ok is True
```

(Adapt `_ontology_with`/`_empty_ontology` and the result accessor `.ok`/`.reason` to the file's actual test helpers and return type.)

- [ ] **Step 3: Run tests to verify they fail** — `python3 -m pytest backend/tests/test_mutation_validator.py -q` — Expected: the new tests FAIL (type change currently disallowed / new param unknown).

- [ ] **Step 4: Implement** — in `validate_node_mutation`, replace the "type change disallowed" branch: when `existing_entity_type` is set and differs (case-insensitive) from `entity_type`, validate the NEW type: parent-side via `can_be_contained_by` membership against `parent_entity_type` (skip if no parent), child-side via `can_contain` membership against each `child_entity_types` entry — all `.upper()`-compared. Keep fail-open when `not ontology.entity_type_definitions`. Return the existing success/failure shape with a plain reason (`f"A {new_name} can't contain a {child_name}."` / `f"A {parent_name} can't contain a {new_name}."`).

- [ ] **Step 5: Run tests to verify they pass** — `python3 -m pytest backend/tests/test_mutation_validator.py -q` — Expected: all pass (existing + 5 new). Confirm no previously-passing test regressed.

- [ ] **Step 6: Commit**

```bash
git add backend/app/ontology/mutation_validator.py backend/tests/test_mutation_validator.py
git commit -m "feat(ontology): validate entity-type changes instead of forbidding them

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Backend — verify `entityType` round-trips through the `/changes` draft-apply + projection

**Files:**
- Test: `backend/tests/test_type_change_roundtrip.py` (new)
- Possibly modify (only if the verification fails): the `/changes` apply and/or projection path — see Step 4.

**Interfaces:**
- Consumes: the existing draft-op apply path that processes `{op:'update', kind:'node', payload:{entityType}}` and the node read-back (`_patch_payload` → `_graphnode_dict`), plus the projector's node-type handling.
- Produces: a passing test proving a node's `entity_type` is updated and returned on read after an `update` op — OR, if it doesn't, a documented gap + the minimal fix.

- [ ] **Step 1: Locate the apply + read path** — find where a draft `update` node op is applied (grep the versioning service for `_patch_payload` / `update` op handling) and where the node is re-read (`_graphnode_dict`). Confirm from Task-1 context that `entityType`/`entity_type` is a top-level field on the node model (it is — `common/models/graph.py` `layer_assignment`'s sibling `entity_type`).

- [ ] **Step 2: Write the round-trip test** — mirror the existing versioning/provider test style (use the same in-memory/fake provider fixtures the layer-assignment or stats tests use; do NOT require a live FalkorDB unless the existing suite already does). Stage/apply an `update` node op setting `entityType` from `dataset` → `container` on a seeded node, then read the node back and assert its type is `container` and other fields (displayName, layerAssignment) are preserved (shallow-merge).

```python
def test_update_op_changes_entity_type_and_preserves_other_fields():
    node = _seed_node(urn="urn:x", entity_type="dataset", display_name="orders", layer_assignment="staging")
    _apply_update_op(node_urn="urn:x", payload={"entityType": "container"})
    got = _read_node("urn:x")
    assert got.entity_type == "container"
    assert got.display_name == "orders"
    assert got.layer_assignment == "staging"
```

- [ ] **Step 3: Run it** — `python3 -m pytest backend/tests/test_type_change_roundtrip.py -q`.
  - If PASS → persistence round-trips; go to Step 5.
  - If FAIL because `entityType` is filtered/ignored on the update path → Step 4.

- [ ] **Step 4 (only if Step 3 failed): minimal fix** — make the `update` op path accept `entityType`/`entity_type` as a mergeable top-level field (mirror how `layerAssignment` is handled). Do NOT touch unrelated fields. If the failure is instead in the **projector** (node re-projected under a stale type/label/kind), STOP and report BLOCKED with the exact projection code and the observed behavior — a projector re-kind is a larger design decision the spec flagged as the top risk; it must be surfaced, not guessed.

- [ ] **Step 5: Commit**

```bash
git add backend/tests/test_type_change_roundtrip.py   # + any file touched in Step 4
git commit -m "test: verify entity-type change round-trips through the /changes draft path

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontend planner — `typesValidForNode`

**Files:**
- Modify: `frontend/src/services/ontologyPreflightService.ts`
- Test: `frontend/src/services/__tests__/ontologyPreflightService.test.ts`

**Interfaces:**
- Consumes: existing `deriveContainmentEdges`, `deriveConnectableEdges`, `sameId`/`findEntityType` in the same file; types `EntityTypeSchema`, `RelationshipTypeSchema` from `@/types/schema`.
- Produces:
```ts
export interface RetypeNode { id: string; urn: string; name: string; type: string }
export interface RetypeContext {
  entityTypes: EntityTypeSchema[]
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  parentTypeOf: (nodeId: string) => string | null
  childrenOf: (nodeId: string) => RetypeNode[]
  incidentLineageEdges: (nodeId: string) => { edgeType: string; role: 'source' | 'target'; otherType: string }[]
}
export function typesValidForNode(node: RetypeNode, ctx: RetypeContext): string[]
```
`typesValidForNode` returns the ids of entity types the node could legally become, sorted by `hierarchy.level` then name.

- [ ] **Step 1: Write failing tests** (append to the preflight test file; reuse its `et(...)` fixture builder):

```ts
// fixture: domain(L0) contains dataPlatform,system; dataPlatform(L1) contains container; container(L2, canContain container,dataset); dataset(L3, canContain column); column(L4 leaf)
it('typesValidForNode: a dataset under dataPlatform can become container (valid child + can hold its column)', () => {
  const ctx = makeCtx({ parentType: 'dataPlatform', children: [{ id:'c', urn:'c', name:'id', type:'column' }] })
  const node = { id:'n', urn:'n', name:'orders', type:'dataset' }
  expect(typesValidForNode(node, ctx)).toContain('container')
})
it('typesValidForNode: excludes types that cannot contain an existing child', () => {
  const ctx = makeCtx({ parentType: 'dataPlatform', children: [{ id:'c', urn:'c', name:'id', type:'column' }] })
  const node = { id:'n', urn:'n', name:'orders', type:'dataset' }
  expect(typesValidForNode(node, ctx)).not.toContain('column') // column can't contain column
})
it('typesValidForNode: excludes types invalid under the parent', () => {
  const ctx = makeCtx({ parentType: 'dataPlatform', children: [] })
  const node = { id:'n', urn:'n', name:'x', type:'dataset' }
  expect(typesValidForNode(node, ctx)).not.toContain('domain') // domain can't be under dataPlatform
})
it('typesValidForNode: a leaf with no children offers all types the parent can contain', () => {
  const ctx = makeCtx({ parentType: 'dataset', children: [] })
  const node = { id:'n', urn:'n', name:'col', type:'column' }
  const res = typesValidForNode(node, ctx)
  expect(res).toContain('column')  // column is a valid child of dataset
})
```

(Write `makeCtx` inline in the test: builds `RetypeContext` from an entity-type fixture + stubbed `parentTypeOf`/`childrenOf`/`incidentLineageEdges`.)

- [ ] **Step 2: Run to verify fail** — `cd frontend && npx vitest run src/services/__tests__/ontologyPreflightService.test.ts` — Expected: FAIL (`typesValidForNode` not exported).

- [ ] **Step 3: Implement** (add to `ontologyPreflightService.ts`):

```ts
function containmentAllowed(parentType: string, childType: string, ctx: RetypeContext): boolean {
  return deriveContainmentEdges(parentType, childType, ctx.relationshipTypes, ctx.containmentEdgeTypes, ctx.entityTypes)
    .some(o => o.allowed)
}
export function typesValidForNode(node: RetypeNode, ctx: RetypeContext): string[] {
  const parentType = ctx.parentTypeOf(node.id)
  const children = ctx.childrenOf(node.id)
  const edges = ctx.incidentLineageEdges(node.id)
  const byLevelThenName = (a: EntityTypeSchema, b: EntityTypeSchema) =>
    (a.hierarchy.level - b.hierarchy.level) || a.name.localeCompare(b.name)
  return [...ctx.entityTypes].sort(byLevelThenName).map(t => t.id).filter(candidate => {
    if (parentType && !containmentAllowed(parentType, candidate, ctx)) return false
    for (const c of children) if (!containmentAllowed(candidate, c.type, ctx)) return false
    for (const e of edges) {
      const opts = deriveConnectableEdges(
        e.role === 'source' ? candidate : e.otherType,
        e.role === 'source' ? e.otherType : candidate,
        ctx.relationshipTypes, ctx.containmentEdgeTypes, ctx.entityTypes,
      )
      const opt = opts.find(o => sameId(o.edgeType, e.edgeType))
      if (opt && !opt.allowed) return false
    }
    return true
  })
}
```

- [ ] **Step 4: Run to verify pass** — `cd frontend && npx vitest run src/services/__tests__/ontologyPreflightService.test.ts` — Expected: all pass. Then `npx tsc -b --pretty false 2>&1 | grep -c "error TS"` — must not exceed baseline.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/ontologyPreflightService.ts frontend/src/services/__tests__/ontologyPreflightService.test.ts
git commit -m "feat(ontology): add typesValidForNode planner helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Frontend planner — `planRetype` (the cascade)

**Files:**
- Modify: `frontend/src/services/ontologyPreflightService.ts`
- Test: `frontend/src/services/__tests__/ontologyPreflightService.test.ts`

**Interfaces:**
- Consumes: `RetypeNode`, `RetypeContext`, `containmentAllowed`, `typesValidForNode` (Task 3).
- Produces:
```ts
export interface RetypeChange   { nodeId: string; urn: string; name: string; fromType: string; toType: string; editable: boolean }
export interface RetypeConflict { nodeId: string; name: string; reason: string }
export interface RetypePlan     { changes: RetypeChange[]; conflicts: RetypeConflict[]; ok: boolean }
export function planRetype(rootNode: RetypeNode, newType: string, ctx: RetypeContext): RetypePlan
```
Root's `toType = newType` (editable:false). Descendants whose type stays valid under the proposed parent are pruned (unchanged, not descended). Invalid descendants get a proposed valid `toType` (editable:true), preferring one whose containment role mirrors the current type, tie-broken by level then name; if none valid → a `conflict`. `changes` ordered parent-before-child. `ok = conflicts.length===0`.

- [ ] **Step 1: Write failing tests** (append; reuse the fixture + `makeCtx`, extended so `childrenOf` returns nested children):

```ts
it('planRetype: uniform up-shift — table->database re-levels columns->tables', () => {
  // fixture where database canContain table; table canContain column; column leaf
  const ctx = makeTreeCtx({ 'db':{type:'table',parent:null,children:['t']}, 't':{type:'column',parent:'db',children:[]} })
  const plan = planRetype({ id:'db', urn:'db', name:'DB', type:'table' }, 'database', ctx)
  expect(plan.ok).toBe(true)
  expect(plan.changes.find(c=>c.nodeId==='db')).toMatchObject({ toType:'database', editable:false })
  expect(plan.changes.find(c=>c.nodeId==='t')).toMatchObject({ toType:'table', editable:true })
})
it('planRetype: prunes descendants that stay valid', () => {
  const ctx = makeTreeCtx({ 'r':{type:'container',parent:'dataPlatform',children:['d']}, 'd':{type:'dataset',parent:'r',children:[]} })
  // container->container is still a valid parent of dataset, so no cascade
  const plan = planRetype({ id:'r', urn:'r', name:'R', type:'container' }, 'container', ctx)
  expect(plan.changes.map(c=>c.nodeId)).toEqual(['r'])
})
it('planRetype: recursive Group->Group cascade terminates', () => {
  const ctx = makeTreeCtx({ 'g':{type:'attribute',parent:'group',children:['g2']}, 'g2':{type:'attribute',parent:'g',children:[]} })
  const plan = planRetype({ id:'g', urn:'g', name:'G', type:'attribute' }, 'group', ctx)
  expect(plan.ok).toBe(true) // group canContain group, so g2->group is valid; terminates
})
it('planRetype: unresolvable child becomes a conflict, ok=false', () => {
  const ctx = makeTreeCtx({ 'r':{type:'dataset',parent:'dataPlatform',children:['x']}, 'x':{type:'column',parent:'r',children:[]} })
  // retype r->column: column can't contain anything -> x has no valid re-level
  const plan = planRetype({ id:'r', urn:'r', name:'R', type:'dataset' }, 'column', ctx)
  expect(plan.ok).toBe(false)
  expect(plan.conflicts.map(c=>c.nodeId)).toContain('x')
})
```

- [ ] **Step 2: Run to verify fail** — `cd frontend && npx vitest run src/services/__tests__/ontologyPreflightService.test.ts` — Expected: FAIL (`planRetype` not exported).

- [ ] **Step 3: Implement** (add to `ontologyPreflightService.ts`):

```ts
function typeName(id: string, ctx: RetypeContext): string {
  return findEntityType(id, ctx.entityTypes)?.name ?? id
}
function childrenStillFit(childId: string, proposedType: string, ctx: RetypeContext): boolean {
  // a proposed type is only usable if its own children (if any) can still nest — checked recursively at visit time,
  // so here just require the type can contain each of the child's current children.
  return ctx.childrenOf(childId).every(gc => containmentAllowed(proposedType, gc.type, ctx))
}
export function planRetype(rootNode: RetypeNode, newType: string, ctx: RetypeContext): RetypePlan {
  const changes: RetypeChange[] = []
  const conflicts: RetypeConflict[] = []
  const visit = (node: RetypeNode, proposedType: string) => {
    changes.push({ nodeId: node.id, urn: node.urn, name: node.name, fromType: node.type, toType: proposedType, editable: node.id !== rootNode.id })
    for (const child of ctx.childrenOf(node.id)) {
      if (containmentAllowed(proposedType, child.type, ctx)) continue // still valid -> prune
      const candidates = [...ctx.entityTypes]
        .sort((a,b)=> (a.hierarchy.level-b.hierarchy.level) || a.name.localeCompare(b.name))
        .map(t=>t.id)
        .filter(ct => containmentAllowed(proposedType, ct, ctx) && childrenStillFit(child.id, ct, ctx))
      if (candidates.length === 0) {
        conflicts.push({ nodeId: child.id, name: child.name, reason: `Nothing valid can go inside a ${typeName(proposedType, ctx)}.` })
        continue
      }
      // preference: keep the same type if it happens to be valid; else first sorted candidate
      const chosen = candidates.includes(child.type) ? child.type : candidates[0]
      visit(child, chosen)
    }
  }
  visit(rootNode, newType)
  return { changes, conflicts, ok: conflicts.length === 0 }
}
```

- [ ] **Step 4: Run to verify pass** — `cd frontend && npx vitest run src/services/__tests__/ontologyPreflightService.test.ts` — Expected: all pass. `npx tsc -b --pretty false 2>&1 | grep -c "error TS"` — not above baseline.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/services/ontologyPreflightService.ts frontend/src/services/__tests__/ontologyPreflightService.test.ts
git commit -m "feat(ontology): add planRetype cascade planner

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Phase 1 Exit Criteria

- Backend accepts+validates type changes (Task 1) and the round-trip is proven or its gap surfaced (Task 2).
- `typesValidForNode` + `planRetype` are exported, pure, and covered by the tests above (Tasks 3-4).
- tsc at/below baseline; only the 2 named pre-existing vitest failures; backend validator + round-trip suites green.
- If Task 2 Step 4 surfaced a projector re-kind gap → STOP; that decision is escalated before Phase 2 (flows) begins.

## Deferred to later plans

- **Phase 2:** auto-promote-on-add-child; manual "Change type" (drawer + context menu) with the editable `RetypePreview`; staging the plan's `changes` as `update_entity` batch.
- **Phase 3:** "Wrap in…" insert-parent; bulk multi-select retype/move.
