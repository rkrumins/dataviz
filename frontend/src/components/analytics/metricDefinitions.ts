/**
 * What every number on this page actually means.
 *
 * "Stickiness 12%" is not self-explanatory to anyone who has not read a growth
 * textbook, and neither is activation, reach, or content concentration. A
 * business dashboard whose terms have to be guessed at gets misread
 * confidently, which is worse than not being read at all.
 *
 * Each definition answers three questions, in this order, because that is the
 * order a reader asks them:
 *
 *   `what`  — plain-language: what is this counting?
 *   `how`   — the actual computation, so a sceptical reader can check it
 *             against the chart rather than trusting the label.
 *   `why`   — what a person should DO differently if it moves. A metric with
 *             no decision attached is trivia, and saying so out loud here is a
 *             design filter: if `why` is hard to write, the tile probably
 *             should not be on the page.
 *
 * Definitions live in data, not in JSX, so the same words appear wherever a
 * metric does and there is one place to fix them.
 */

export interface MetricDefinition {
    /** The label as it appears on the tile — used as the popover heading. */
    title: string
    what: string
    how: string
    why?: string
    /** Set when the measure only exists from a certain date onwards. */
    caveat?: string
}

export const METRICS: Record<string, MetricDefinition> = {
    activeUsers: {
        title: 'Active users',
        what: 'People who actually did something in the selected period — opened a view, traced lineage, edited or shared something.',
        how: 'Distinct people appearing in the activity log or product events inside the range. Signing in without doing anything does not count.',
        why: 'The honest size of your user base. Total accounts only ever goes up; this one can go down, which is what makes it worth watching.',
    },
    totalUsers: {
        title: 'Total users',
        what: 'Every account that exists and has not been deleted.',
        how: 'All-time count, not limited by the date range. The change compares accounts created in this period against the one before.',
        why: 'The headline number for growth. Read it next to active users — a gap that widens means people are signing up and not coming back.',
    },
    workspaces: {
        title: 'Workspaces',
        what: 'Every workspace that exists and has not been deleted.',
        how: 'All-time count, not limited by the date range. The change compares workspaces created in this period against the one before.',
        why: 'Workspace count is reach across teams. Read it beside the dormant count — created and abandoned is not growth.',
    },
    views: {
        title: 'Views',
        what: 'Saved views across every workspace — context views, canvases and the rest.',
        how: 'All-time count of views not deleted. The change compares views created in this period against the one before.',
        why: 'What people have built. Views created without opens means effort is going in and nothing is coming back out.',
    },
    actionsTaken: {
        title: 'Actions taken',
        what: 'Every recorded thing a person did to a view — created, edited, shared, renamed, deleted, opened.',
        how: 'Rows in the view activity log inside the range. One row per action, so one busy person can move this a long way.',
        why: 'Depth of use, as opposed to how many people showed up. Compare it against active users to see whether use is broad or concentrated.',
    },
    semanticLayers: {
        title: 'Semantic layers',
        what: 'Ontologies that give raw technical metadata a business meaning — what a table IS, not just what it is called.',
        how: 'Published ontologies across all workspaces, with context models counted separately beneath.',
        why: 'Sources without one show column names and types only. Coverage here is what makes lineage readable by people who did not build the pipeline.',
    },
    neverRefreshed: {
        title: 'Never refreshed',
        what: 'Live data sources that were not refreshed at any point in the selected period.',
        how: 'Sources with no refresh recorded inside the range. A source refreshed the day before the range starts still counts here.',
        why: 'Lineage drawn from a stale source looks exactly as confident as lineage drawn from a current one. This is where that risk sits.',
    },
    sourcesDrifting: {
        title: 'Sources drifting',
        what: 'Sources whose schema has changed since their mapping was written.',
        how: 'Detected by comparing the current schema against the one the mapping was authored against.',
        why: 'Drift silently breaks lineage: the graph keeps drawing edges from columns that have moved or gone. Re-map these first.',
    },
    entityTypes: {
        title: 'Entity types modelled',
        what: 'How many distinct kinds of thing the graph knows about — table, dashboard, job, and so on.',
        how: 'Distinct entity types across every node currently in the graph.',
        why: 'Breadth of modelling. A graph with two entity types is a table list; lineage gets useful as the estate around the tables is described too.',
    },
    stickiness: {
        title: 'Stickiness',
        what: 'Whether people use this daily or occasionally.',
        how: 'Daily active users divided by monthly active users. 20% means the average person shows up about one day in five.',
        why: 'Above ~20% the platform is part of the working day. Below ~10% it is a place people visit when something breaks — useful, but not habitual.',
    },
    activation: {
        title: 'Activation',
        what: 'The share of people who signed up in this period and went on to trace lineage.',
        how: 'Tracing is the value moment: it is the question this platform exists to answer. Creating a view is tracked separately as its own rate.',
        why: 'The clearest measure of whether onboarding works. A low rate means people arrive and never reach the thing they came for.',
        caveat: 'Only counts traces recorded since lineage instrumentation shipped.',
    },
    traceSuccess: {
        title: 'Traces that found lineage',
        what: 'How often someone asked for lineage and got an answer.',
        how: 'Traces returning at least one upstream or downstream node, divided by all traces run.',
        why: 'A trace that comes back empty is a failed value moment, and it is invisible in every other number here — view opens and activity both count it as engagement.',
    },
    searchHit: {
        title: 'Searches that matched',
        what: 'How often a graph search found something.',
        how: 'Searches returning at least one match, divided by all searches run.',
        why: 'Misses tell you what people expected the graph to contain and it did not — either coverage is missing, or search is not finding what is there.',
    },
    viewOpens: {
        title: 'View opens',
        what: 'How many times a saved view was opened.',
        how: 'One event per open, so the same person opening the same view twice counts twice. Distinct people are counted separately as viewers.',
        why: 'Attention. Read it against active users: many opens from few people is a small group leaning on the platform heavily.',
        caveat: 'Recorded from the day open-tracking shipped; earlier ranges show none because none were counted.',
    },
    concentration: {
        title: 'Top-10 share',
        what: 'The share of all view opens going to the ten most-opened views.',
        how: 'Opens of the top ten views divided by total opens in the range.',
        why: 'High concentration means the catalogue is not being discovered — a handful of views are carrying everything and the rest may as well not exist.',
    },
    collaboration: {
        title: 'Shared openly',
        what: 'The share of views visible beyond the person who made them.',
        how: 'Views set to workspace or everyone visibility, divided by all live views.',
        why: 'Low means people are building for themselves rather than for their team — knowledge is being created and not shared.',
    },
    timeToValue: {
        title: 'Time to first view',
        what: 'How long a new person takes to build something of their own.',
        how: 'Median days from signing up to creating a first view, measured over people whose first view landed inside the range.',
        why: 'Falling is good. A long lag usually points at onboarding or missing permissions rather than at the people.',
    },
    reach: {
        title: 'Reach',
        what: 'The share of ACTIVE people who used a given feature.',
        how: 'Distinct users of the feature divided by distinct active users in the range — not divided by all accounts, which would measure dormancy instead of adoption.',
        why: 'Separates "a few people use it a lot" from "everyone uses it a bit". Both look identical in a raw event count.',
    },
    refreshSuccess: {
        title: 'Refresh success',
        what: 'How reliably data sources refreshed in this period.',
        how: 'Refreshes that completed, divided by all refresh attempts.',
        why: 'Rising usage on stale data is the worst kind of good news. This is the counter-signal to every engagement number on the page.',
    },
    semanticCoverage: {
        title: 'Semantic layer coverage',
        what: 'The share of data sources with an ontology assigned.',
        how: 'Live sources with an ontology, divided by all live sources.',
        why: 'A source with no semantic layer shows raw technical metadata — the product without the thing that differentiates it.',
    },
    dormantWorkspaces: {
        title: 'Dormant workspaces',
        what: 'Workspaces with no activity at all in the selected period.',
        how: 'No view opens and no logged actions inside the range. Age is not considered — a workspace made yesterday is not dormant.',
        why: 'The earliest churn signal you get, and it names exactly which teams to go and talk to.',
    },
    inviteAcceptance: {
        title: 'Invite acceptance',
        what: 'The share of invitations that were redeemed.',
        how: 'Invites redeemed in the range divided by invites sent in it. An invite sent late in the period may still be redeemed after it.',
        why: 'Low acceptance throttles growth upstream of everything else here — these are people who were asked and never arrived.',
    },
    ghostLine: {
        title: 'The faded line',
        what: 'The same measure over the period immediately before this one.',
        how: 'Aligned by position rather than by date, so the third bucket of last month sits under the third of this one.',
        why: 'The percentage change tells you a number moved. This tells you the shape — steady growth, one spike, and a late collapse all produce the same percentage.',
    },
}
