/**
 * Where data can live, as Ask for data offers it: each system with its look (icon and
 * colours — literal Tailwind classes, never interpolated) and the words that help
 * someone describe what they need from it. Plus how soon it is needed, and what each
 * status reads as.
 */
import {
    ChartNetwork, Clock, Database, FileSpreadsheet, Layers, Leaf, Snowflake, Sparkles, Workflow, Zap,
    type LucideIcon,
} from 'lucide-react'
import { DataHubLogo, Neo4jLogo } from '@/components/admin/ProviderLogos'
import type { DataRequestStatus, DataRequestSystem, DataRequestUrgency } from '@/services/dataRequestsService'

export interface SystemOption {
    value: DataRequestSystem
    label: string
    /** One line under the name: what it is, for someone who doesn't know. */
    detail: string
    icon: LucideIcon | React.ComponentType<{ className?: string }>
    /** Icon colour, its tile, and the selected card's ring. */
    tone: string
    tile: string
    ring: string
    /** The title's placeholder. */
    titleExample: string
    /** The "what exactly" placeholder, in the system's own terms. */
    detailsPlaceholder: string
    /** What to name, if they know it. */
    hint: string
}

export const SYSTEMS: SystemOption[] = [
    {
        value: 'snowflake', label: 'Snowflake', detail: 'Warehouse databases and schemas', icon: Snowflake,
        tone: 'text-sky-500', tile: 'bg-sky-500/10', ring: 'border-sky-500 bg-sky-500/[0.06] shadow-sky-500/10',
        titleExample: 'Finance marts', detailsPlaceholder: 'e.g. FIN_DB.MARTS — gl_balances, ap_invoices, and the views on them',
        hint: 'Name the database and schema if you know them — tables help, but aren’t required.',
    },
    {
        value: 'databricks', label: 'Databricks', detail: 'Unity Catalog, notebooks and jobs', icon: Layers,
        tone: 'text-orange-500', tile: 'bg-orange-500/10', ring: 'border-orange-500 bg-orange-500/[0.06] shadow-orange-500/10',
        titleExample: 'Customer 360 tables', detailsPlaceholder: 'e.g. catalog prod, schema customer — the gold tables and the jobs that build them',
        hint: 'A catalog and schema, or the workspace URL, is plenty to start with.',
    },
    {
        value: 'bigquery', label: 'BigQuery', detail: 'Google Cloud projects and datasets', icon: ChartNetwork,
        tone: 'text-blue-500', tile: 'bg-blue-500/10', ring: 'border-blue-500 bg-blue-500/[0.06] shadow-blue-500/10',
        titleExample: 'Marketing attribution', detailsPlaceholder: 'e.g. project acme-analytics, dataset marketing — campaigns and touchpoints',
        hint: 'The project and dataset names help the platform team find it.',
    },
    {
        value: 'postgres', label: 'PostgreSQL', detail: 'An application or operational database', icon: Database,
        tone: 'text-indigo-500', tile: 'bg-indigo-500/10', ring: 'border-indigo-500 bg-indigo-500/[0.06] shadow-indigo-500/10',
        titleExample: 'Billing database', detailsPlaceholder: 'e.g. the billing service’s database — invoices, payments and customers',
        hint: 'Which application it belongs to is often the quickest way to find it.',
    },
    {
        value: 'dbt', label: 'dbt', detail: 'Models, sources and their lineage', icon: Workflow,
        tone: 'text-rose-500', tile: 'bg-rose-500/10', ring: 'border-rose-500 bg-rose-500/[0.06] shadow-rose-500/10',
        titleExample: 'dbt project “core”', detailsPlaceholder: 'e.g. the core project — finance and marts models, and the sources they read',
        hint: 'The project’s name or repository is enough; the lineage comes from its models.',
    },
    {
        value: 'datahub', label: 'DataHub', detail: 'A metadata catalog already in use', icon: DataHubLogo,
        tone: 'text-blue-600', tile: 'bg-blue-600/10', ring: 'border-blue-600 bg-blue-600/[0.06] shadow-blue-600/10',
        titleExample: 'Platform lineage from DataHub', detailsPlaceholder: 'e.g. the Finance domain, or everything tagged “regulatory”',
        hint: 'A domain, platform or tag narrows it down.',
    },
    {
        value: 'neo4j', label: 'Neo4j', detail: 'A graph database', icon: Neo4jLogo,
        tone: 'text-cyan-600', tile: 'bg-cyan-500/10', ring: 'border-cyan-500 bg-cyan-500/[0.06] shadow-cyan-500/10',
        titleExample: 'Supply chain graph', detailsPlaceholder: 'e.g. the supply-chain database — suppliers, parts and shipments',
        hint: 'The database name, and the labels you care about, if you know them.',
    },
    {
        value: 'file', label: 'A file', detail: 'A spreadsheet, CSV or export', icon: FileSpreadsheet,
        tone: 'text-emerald-500', tile: 'bg-emerald-500/10', ring: 'border-emerald-500 bg-emerald-500/[0.06] shadow-emerald-500/10',
        titleExample: 'System inventory spreadsheet', detailsPlaceholder: 'e.g. the application inventory spreadsheet on the Finance SharePoint, refreshed monthly',
        hint: 'Say where the file lives and how often it changes — don’t attach it here.',
    },
    {
        value: 'other', label: 'Something else', detail: 'Not sure, or not listed', icon: Sparkles,
        tone: 'text-violet-500', tile: 'bg-violet-500/10', ring: 'border-violet-500 bg-violet-500/[0.06] shadow-violet-500/10',
        titleExample: 'Data from our CRM', detailsPlaceholder: 'e.g. the opportunity data in Salesforce — whatever feeds the pipeline report',
        hint: 'Describe it in your own words. The platform team will work out where it lives.',
    },
]

export const systemOf = (s: DataRequestSystem | string) => SYSTEMS.find(x => x.value === s) ?? SYSTEMS[SYSTEMS.length - 1]

export const URGENCIES: { value: DataRequestUrgency; label: string; detail: string; icon: LucideIcon }[] = [
    { value: 'no_rush', label: 'No rush', detail: 'Whenever it fits', icon: Leaf },
    { value: 'this_month', label: 'This month', detail: 'Within a few weeks', icon: Clock },
    { value: 'this_week', label: 'This week', detail: 'It’s holding work up', icon: Zap },
]

export const urgencyOf = (u: DataRequestUrgency | string) => URGENCIES.find(x => x.value === u) ?? URGENCIES[0]

/** The badge an urgent request wears; none for no rush. */
export const URGENCY_BADGE: Partial<Record<DataRequestUrgency, string>> = {
    this_month: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    this_week: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
}

export const STATUS_LABEL: Record<DataRequestStatus, string> = {
    pending: 'Asked', in_progress: 'In progress', connected: 'Connected', declined: 'Declined', withdrawn: 'Withdrawn',
}

export const STATUS_PILL: Record<DataRequestStatus, string> = {
    pending: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    in_progress: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    connected: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    declined: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    withdrawn: 'bg-black/[0.05] dark:bg-white/[0.07] text-ink-secondary',
}
