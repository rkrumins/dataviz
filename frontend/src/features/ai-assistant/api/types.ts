/**
 * The AI service's HTTP contract (v1), as the assistant reads it — `/api/v1/ai/*`.
 *
 * Shapes only. Every entity reference is an `Entity`; `path` is the containers it sits in, top
 * level first, names only.
 */
import type { Predicate } from '@/types/search'

export type AssistantPersona = 'data' | 'help'

// ─── Status ───────────────────────────────────────────────────────────────────

export interface AiStatus {
    /** A chat connection is set and enabled. */
    configured: boolean
    personas: { data: boolean; help: boolean }
    knowledge?: { docs: 'ready' | 'lexical' | 'unavailable'; views: 'ready' | 'disabled' | 'unavailable' }
    dataPolicy?: { sendDescriptions: boolean; sendPropertyValues: boolean; sendSampleValues: boolean }
    /** Shown as "Answers by …". */
    connectionName?: string | null
    limits?: { maxStepsPerTurn: number }
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

export type AssistantPageKind = 'view' | 'workspace' | 'data_source' | 'explorer' | 'ontology' | 'doc'

/** The page the question is asked on. On a view: `{kind: 'view', id: viewId, title: viewName}`. */
export interface AssistantPage {
    kind: AssistantPageKind
    /** The viewId, workspaceId, catalogId (a data source page), ontologyId, or a doc's route. */
    id?: string
    /** What the page is called, for the chip and the model. */
    title?: string
}

export interface ChatContext {
    route?: string
    workspaceId?: string
    dataSourceId?: string
    viewId?: string
    viewName?: string
    /** What is selected on the canvas — at most 25. */
    selectedUrns?: string[]
    /** The entity the panel was opened about (its drawer, a right-click). */
    focusUrn?: string
    /** The Advanced Search draft, if any. */
    searchPredicate?: Predicate
    personaMode?: 'business' | 'technical'
    page?: AssistantPage
}

export interface ClarificationAnswer {
    id: string
    optionId: string
    remember: boolean
}

export interface ChatRequest {
    /** Left out to start a new conversation. */
    conversationId?: string
    /** May be empty when `clarification` answers a question instead. */
    message: string
    persona: AssistantPersona | 'auto'
    context: ChatContext
    clarification?: ClarificationAnswer
}

export interface Entity {
    urn: string
    name: string
    type: string
    path?: string[]
}

export type StepStatus = 'running' | 'done' | 'error'

export interface Step {
    id: string
    label: string
    status: StepStatus
    detail?: string
}

export type ActionKind = 'open_view' | 'open_trace' | 'open_search' | 'reveal' | 'open_doc' | 'open_cypher'

export interface AssistantAction {
    id: string
    kind: ActionKind | string
    label: string
    payload: Record<string, unknown>
}

export interface TurnError {
    code: string
    message: string
}

// ─── Blocks (§4) ──────────────────────────────────────────────────────────────

export interface TypeCount {
    type: string
    label: string
    count: number
}

export interface ContainerCount {
    entity: Entity
    count: number
}

/** Where a block's data came from — the scope its actions act in. */
export interface BlockScope {
    workspaceId?: string
    dataSourceId?: string
    viewId?: string
}

export interface BlockQuery {
    predicate: Predicate
    scopeMode: 'view' | 'data_source'
}

export interface ResultsData extends BlockScope {
    title: string
    total: number
    totalExact: boolean
    byType?: TypeCount[]
    byContainer?: ContainerCount[]
    items: Entity[]
    resultRef?: string
    query?: BlockQuery
    notes?: string[]
}

export type ImpactChange = 'drop' | 'rename' | 'type_change' | 'remove'

export interface ImpactOwner {
    owner: string
    property: string
    count: number
    assets: Entity[]
}

export interface ImpactPath {
    nodes: Entity[]
    edges: Array<{ type: string; detail?: string | null }>
}

export interface ImpactTiming {
    schedules: Array<{ job: Entity; schedule: string; human: string }>
    note?: string
}

export interface ImpactData extends BlockScope {
    direction: 'downstream' | 'upstream'
    target: Entity
    /** Null for a plain lineage trace: nothing is changing. */
    change: ImpactChange | null
    severity: 'high' | 'medium' | 'low'
    severityReasons?: string[]
    summary: string
    totals: { entities: number; exact: boolean; byType?: TypeCount[] }
    byContainer?: ContainerCount[]
    /** Downstream: the terminal consumers. Upstream: the original sources. */
    consumers?: Array<Entity & { hops?: number }>
    owners?: ImpactOwner[]
    paths?: ImpactPath[]
    timing?: ImpactTiming | null
    /** `fine`: physical lineage. `coarse`: rolled up from coarser links. */
    grain?: 'fine' | 'coarse'
    truncated?: boolean
    notes?: string[]
    trace?: { urn: string; direction: 'downstream' | 'upstream'; depth: number }
    resultRef?: string
    query?: BlockQuery
}

export interface QueryData extends BlockScope {
    language: 'search' | 'cypher'
    predicate?: Predicate | null
    cypher?: string | null
    explanation?: string
    assumptions?: string[]
    count?: number | null
    countExact?: boolean
    /** Cypher only. */
    guard?: { ok: true } | { ok: false; message: string } | null
}

export interface ViewSuggestion {
    id: string
    name: string
    description?: string | null
    workspaceName?: string | null
    dataSourceName?: string | null
    tags?: string[]
    reason?: string | null
    updatedAt?: string | null
}

export interface ViewsData {
    items: ViewSuggestion[]
}

export interface Citation {
    n: number
    title: string
    section?: string | null
    href?: string | null
    snippet?: string | null
    source: string
    trust: 'product' | 'external'
}

export interface CitationsData {
    items: Citation[]
}

export interface EntityData extends BlockScope {
    entity: Entity
    description?: string | null
    properties?: Array<{ key: string; value: unknown }>
    tags?: string[]
}

export interface NoticeData {
    tone: 'info' | 'warning'
    text: string
}

// ─── Clarify (§5) ─────────────────────────────────────────────────────────────

export interface ClarifyOption {
    id: string
    label: string
    description?: string | null
    count?: number | null
}

export interface Clarification {
    id: string
    question: string
    /** The business term it is about, when there is one. */
    concept?: string | null
    options: ClarifyOption[]
    allowRemember?: boolean
    allowOther?: boolean
    /** Stored ones say whether they were answered. */
    answered?: boolean
    /** The option chosen here, once answered in this session. */
    chosen?: string
}

// ─── Context brief (GET /context, and the `context` block) ────────────────────

/** What the page knows about itself; send what it knows. */
export interface ContextBriefParams {
    viewId?: string
    workspaceId?: string
    dataSourceId?: string
    pageKind?: AssistantPageKind
    pageId?: string
    pageTitle?: string
}

export interface BriefType {
    id: string
    name: string
    plural?: string | null
    description?: string | null
    /** 0 = top of the hierarchy. */
    level?: number | null
    /** Entities of this type in the view (catalogue). */
    inView?: number | null
    /** Entities of this type in the whole data source (introspection). */
    inSource?: number | null
    /** Type ids. */
    contains: string[]
    containedBy: string[]
    root: boolean
}

export interface BriefConnection {
    id: string
    name: string
    class: 'containment' | 'lineage' | 'other'
    category?: string | null
    description?: string | null
    /** Type ids. */
    from: string[]
    to: string[]
    /** Edges of this type in the data source. */
    count?: number | null
}

export interface BriefCaveat {
    code: string
    text: string
    action?: 'confirm_type' | null
}

/** What the assistant knows about the page — everything the person can read, never cut by policy. */
export interface ContextBrief {
    kind: AssistantPageKind | 'app'
    about: {
        name: string
        description?: string | null
        workspace?: string | null
        dataSource?: string | null
        semanticLayer?: string | null
        template?: string | null
        layout?: string | null
        tags?: string[]
        owner?: string | null
        updatedAt?: string | null
        dataUpdatedAt?: string | null
        visibility?: string | null
        viewId?: string | null
        workspaceId?: string | null
        dataSourceId?: string | null
    }
    scope?: {
        entityScope?: 'all' | 'curated' | null
        visibleTypes?: string[]
        maxDepth?: number | null
        roots?: number | null
    } | null
    /** In order. */
    layers?: Array<{ name: string; description?: string | null; types: string[] }>
    /** Ranked: in view, then level. */
    types?: BriefType[]
    /** Up to 3 root→leaf chains of type ids. */
    hierarchy?: { chains: string[][] }
    /** Ranked by count. */
    connections?: BriefConnection[]
    contents?: {
        entities?: number | null
        /** False while the catalogue is still being read. */
        complete: boolean
        properties: Array<{ key: string; count: number; coverage?: number | null; kinds: string[] }>
        propertiesNotShown: number
        tags: Array<{ tag: string; count: number }>
    } | null
    /** The property that says what kind of thing each entity is, on a generic schema. */
    typeProperty?: {
        status: 'suggested' | 'confirmed'
        on: string
        key: string
        values: Array<{ value: string; count: number }>
        alternatives?: Array<{ key: string; coverage: number; distinct: number }>
    } | null
    caveats: BriefCaveat[]
    notes: string[]
    /** Data source and Explorer pages: the view the answers read through. */
    seenThrough?: { viewId: string; name: string } | null
    /** Workspace page. */
    dataSources?: Array<{ id: string; name: string; semanticLayer?: string | null }>
    /** Semantic layer page. */
    usedBy?: Array<{ workspace: string; dataSource: string }>
    /** Doc page: its section headings. */
    headings?: string[]
}

export type Block =
    | { id: string; type: 'results'; data: ResultsData }
    | { id: string; type: 'impact'; data: ImpactData }
    | { id: string; type: 'query'; data: QueryData }
    | { id: string; type: 'views'; data: ViewsData }
    | { id: string; type: 'citations'; data: CitationsData }
    | { id: string; type: 'entity'; data: EntityData }
    | { id: string; type: 'notice'; data: NoticeData }
    | { id: string; type: 'clarify'; data: Clarification }
    | { id: string; type: 'context'; data: ContextBrief }

// ─── Conversations (§3) ───────────────────────────────────────────────────────

export interface ConversationSummary {
    id: string
    title: string
    persona: AssistantPersona
    workspaceId?: string | null
    viewId?: string | null
    updatedAt: string
    messageCount: number
}

export interface StoredMessage {
    id: string
    role: 'user' | 'assistant'
    content: string
    blocks?: Block[]
    steps?: Step[]
    followups?: string[]
    actions?: AssistantAction[]
    status?: 'ok' | 'clarify' | 'error'
    feedback?: -1 | 1 | null
    createdAt?: string
}

export interface Conversation {
    id: string
    title: string
    persona: AssistantPersona
    messages: StoredMessage[]
}

// ─── Query drafting (§7) ──────────────────────────────────────────────────────

export interface DraftRequest {
    context: BlockScope
    question: string
    mode: 'search' | 'cypher'
    currentPredicate?: Predicate
    /** Answers to the draft's clarifications, by clarification id. */
    choices?: Record<string, string>
}

export interface DraftResponse {
    mode: 'search' | 'cypher'
    predicate: Predicate | null
    cypher: string | null
    explanation: string
    assumptions: string[]
    count?: number | null
    countExact?: boolean
    clarification: Clarification | null
    guard: { ok: true } | { ok: false; message: string } | null
}

// ─── Concepts (§8) ────────────────────────────────────────────────────────────

export interface Concept {
    id: string
    concept: string
    label: string
    scope: 'personal' | 'workspace'
    predicate: Predicate
    uses: number
    updatedAt: string
}
