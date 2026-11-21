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
        how: 'Published ontologies across all workspaces, with the layout templates people made counted separately beneath.',
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
    notOpened: {
        title: 'Not opened',
        what: 'Views that exist and that nobody opened at all in the selected period.',
        how: 'Live views, minus the ones with at least one recorded open inside the range. A view opened the day before the range started counts here.',
        why: 'The other half of Top-10 share. Concentration says attention is narrow; this says how much of the catalogue is getting none of it — which is either content nobody can find, or content nobody wanted. Both are worth knowing before anyone builds more.',
        caveat: 'Counts opens recorded since open-tracking shipped, so a range reaching further back overstates this.',
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
    entities: {
        title: 'Entities',
        what: 'How many things the platform holds across every live data source — tables, columns, dashboards, jobs and whatever else the sources describe.',
        how: 'Each source\'s count from its daily profile, at the end of every period, summed. A source the profiler missed for a day keeps its last count; a deleted source stops counting the day it was deleted. The change is the end of the range against its start.',
        why: 'The size of what people can trace. Growth here with flat usage means sources are arriving faster than anyone is looking at them.',
        caveat: 'Daily profiles start when profiling was switched on; earlier periods show no data rather than zero.',
    },
    relationships: {
        title: 'Relationships',
        what: 'How many connections the platform holds between those entities — lineage, containment and the rest.',
        how: 'Read the same way as entities, from the same daily profiles. It includes the lineage rollup the platform maintains, as the Profiling board does.',
        why: 'Relationships are what lineage is made of. Entities growing without relationships means new things are arriving disconnected.',
    },
    sourcesOnboarded: {
        title: 'Sources onboarded',
        what: 'Data sources connected in the range — whether still connected or since removed.',
        how: 'Data sources created in the range, against the same length of time before it. The total underneath is every source connected now.',
        why: 'The pace of onboarding. Read it beside time to first build: sources added faster than they are built means a queue is forming.',
    },
    versionControlShare: {
        title: 'Under version control',
        what: 'The share of connected sources whose graph is kept in version history — drafts, reviews and a full record of change.',
        how: 'Sources with a live versioned graph, divided by every connected source.',
        why: 'Version control is how changes to a graph get reviewed before they reach everyone. A low share is fine for read-only sources and a risk for edited ones.',
    },
    firstBuild: {
        title: 'Time to first build',
        what: 'How long a newly connected source waited for its first completed aggregation — the moment its lineage became usable.',
        how: 'For sources connected in the range: the first completed aggregation run minus when the source was added. The middle value is shown.',
        why: 'The wait between connecting a source and being able to use it. If it grows, onboarding is outrunning the build capacity.',
    },
    uniqueViewers: {
        title: 'Viewers',
        what: 'Distinct people who opened at least one view in the range.',
        how: 'People with at least one view open in the range, against the same length of time before it.',
        why: 'Reach, not volume: a hundred opens by one person and one open each by a hundred people are very different platforms.',
    },
    firstOpen: {
        title: 'Time to first open',
        what: 'How soon a new view is opened by someone other than the person who built it.',
        how: 'For views built in the range: the first open by anyone but its author, minus when it was built. The middle value is shown.',
        why: 'A view nobody else opens is a draft. If this grows, people are building for themselves rather than for their team.',
    },
    presence: {
        title: 'Presence',
        what: 'Where everyone with an account stands today: active this week, seen this week, seen this month, gone quiet, or never signed in.',
        how: 'From each account\'s last activity, last visit and last sign-in, as of now — not limited by the range.',
        why: 'The size of the audience that is actually around. A large dormant band is the first group to win back.',
    },
    runsByHand: {
        title: 'Runs started by hand',
        what: 'Aggregation runs a person started — a rebuild, a retry, a resume — rather than automation.',
        how: 'Runs that record who started them, plus those started from the manual trigger, in the range against the same length of time before it.',
        why: 'Every run started by hand is a person doing what automation should. A source that needs it often is a candidate for a schedule or a fix.',
        caveat: 'Who started a run is recorded from this release on.',
    },
    ingestionFailureRate: {
        title: 'Run failure rate',
        what: 'The share of finished aggregation runs that failed.',
        how: 'Failed runs divided by runs that completed or failed, in the range. Running, waiting and cancelled runs are not counted.',
        why: 'Failures cost a rebuild each, and someone\'s time. A rising rate usually traces back to one or two sources.',
    },
    workspacePulse: {
        title: 'Workspace pulse',
        what: 'How much happens in each workspace, period by period.',
        how: 'Changes recorded against the workspace in the activity log, edits to its views, and opens of its views, per period.',
        why: 'A total hides a workspace that went quiet halfway through the range. The pulse shows it as a gap in its own row.',
    },

    // ── Collaboration ───────────────────────────────────────────────
    questionsAsked: {
        title: 'Questions asked',
        what: 'Questions people asked about a view or a data source in the range — open and private ones alike.',
        how: 'Conversations started in the range, against the same length of time before it. Deleted conversations, archived ones, and those about a view or source that has since been deleted are not counted. The total underneath is every question still counted, all time.',
        why: 'Questions are demand for knowledge the platform does not yet answer by itself. Rising questions about one source usually mean its description is missing or wrong.',
    },
    answerRate: {
        title: 'Answer rate',
        what: 'The share of the questions asked in the range that now have an accepted answer.',
        how: 'Questions asked in the range with a reply accepted as the answer, divided by all questions asked in the range. A question closed after its answer was accepted still counts as answered.',
        why: 'A question with replies but no accepted answer may still be unresolved. A low rate means people are asking and not getting what they came for.',
        caveat: 'The period before has had longer to collect answers, so it tends to read higher than a period that has only just ended.',
    },
    firstResponse: {
        title: 'Time to first reply',
        what: 'How long a question waited for its first reply from someone other than the person who asked.',
        how: 'For questions asked in the range that have had a reply: the first reply by anyone but the asker, minus when the question was asked. The middle value is shown. Questions with no reply yet are not in it — they are counted under Waiting over a week once they are old enough.',
        why: 'The wait someone feels. A long first reply is the moment people stop asking and start guessing.',
    },
    timeToAnswer: {
        title: 'Time to an accepted answer',
        what: 'How long a question took to be resolved by an accepted answer.',
        how: 'For questions asked in the range and answered now: when the answer was accepted, minus when the question was asked. The middle value is shown.',
        why: 'The gap between a first reply and an accepted answer is how much back-and-forth a question takes. If it grows, the first replies are not landing.',
        caveat: 'A question closed after its answer was accepted counts as answered but cannot be timed: closing it records the close, not the acceptance.',
    },
    waitingOverWeek: {
        title: 'Waiting over a week',
        what: 'Questions still open with no accepted answer, asked more than seven days ago.',
        how: 'As of now, whatever the range: open questions older than seven days. Some may have replies; none has an accepted answer and none was closed.',
        why: 'Each one is a person still waiting on someone. The longest-waiting list below names which views and sources they are about.',
    },
    peopleAsking: {
        title: 'People asking',
        what: 'Distinct people who asked at least one question in the range.',
        how: 'Distinct askers of the questions asked in the range, against the same length of time before it.',
        why: 'Breadth, not volume: ten questions from one person and one each from ten people are very different signals.',
    },
    peopleAnswering: {
        title: 'People answering',
        what: 'Distinct people who replied to someone else’s question in the range.',
        how: 'Distinct authors of replies posted in the range, leaving out replies to their own questions. Deleted replies are not counted.',
        why: 'How widely knowledge is shared. If a handful of people answer everything, they are a bottleneck — and a single point of failure.',
    },
    repliesPosted: {
        title: 'Replies posted',
        what: 'Replies posted in the range, on any question still counted.',
        how: 'Every reply posted in the range, including the asker’s own follow-ups, against the same length of time before it. Deleted replies are not counted.',
        why: 'The volume of conversation. Read it beside questions asked: many replies per question means questions take a lot of back-and-forth.',
    },
    askedPrivately: {
        title: 'Asked privately',
        what: 'The share of questions asked in the range that only their participants, the subject’s maintainers and the workspace’s admins can see.',
        how: 'Private questions asked in the range divided by all questions asked in the range.',
        why: 'An answer given in private helps one person. A high share means knowledge is being shared in a way the next person cannot find.',
    },
    mostDiscussed: {
        title: 'Most discussed',
        what: 'The views and data sources people said most about in the range.',
        how: 'Questions asked in the range plus replies posted in the range, on each view or source. Open is how many of its questions are open now, whatever their age; answered is of the questions asked in the range.',
        why: 'Where people need help. A view or source near the top is worth a better description, or a named contact who can answer.',
    },
    topAnswerers: {
        title: 'People who answer most',
        what: 'The people whose answers were accepted most, and who replied most to other people’s questions.',
        how: 'Accepted answers: questions asked in the range whose accepted answer they wrote. Replies: replies in the range to questions they did not ask.',
        why: 'The people your platform leans on. Thank them — and make sure what they know is written down where the next person will find it.',
    },
    longestWaiting: {
        title: 'Longest waiting',
        what: 'The open questions that have waited longest for an accepted answer.',
        how: 'Open questions, oldest first, as of now — not limited by the range. Age is counted in whole days from when the question was asked.',
        why: 'The oldest open question is someone who asked and gave up. Ask the people who answer for that view or source to pick it up.',
    },

    // ── Data: describing sources, and requests ──────────────────────
    sourcesDescribed: {
        title: 'Described',
        what: 'The share of data sources with a description.',
        how: 'Live sources with a description that is not blank, divided by every live source. Forks are not counted: they read their parent’s graph and are not listed.',
        why: 'A source with no description is one people have to ask about. This is the first thing a newcomer reads.',
    },
    sourcesTagged: {
        title: 'Tagged',
        what: 'The share of data sources with at least one tag.',
        how: 'Live sources with one or more tags, divided by every live source.',
        why: 'Tags are how people find sources by subject rather than by name. Untagged sources only turn up for people who already know what they are called.',
    },
    sourcesWithContacts: {
        title: 'Named contacts',
        what: 'The share of data sources that name an Owner or at least one Steward.',
        how: 'Live sources with an Owner or a Steward saved on their details, divided by every live source. A source that names nobody still routes questions to people worked out from its permissions — that is a default, so it is not counted here.',
        why: 'Questions about a source go to its named contacts first. Without them, questions land on whoever happens to manage the workspace.',
    },
    trustStatus: {
        title: 'Trust',
        what: 'How data sources are marked for trust: certified, in review, deprecated, or not marked.',
        how: 'Every live source by its current trust status.',
        why: 'A certified source is one people can rely on without asking. A large unmarked share means people cannot tell the trusted sources from the rest.',
    },
    classification: {
        title: 'Classification',
        what: 'How sensitive the data in each source is marked to be: public, internal, confidential, restricted, or not marked.',
        how: 'Every live source by its classification. It is a label for people to read; it is not the publish restriction.',
        why: 'Unclassified sources are the ones nobody has looked at with sensitivity in mind.',
    },
    topTags: {
        title: 'Most used tags',
        what: 'The tags on the most data sources.',
        how: 'Each tag counted once per source, ignoring capitals, across every live source. A tag used only in workspaces you cannot see is not listed for you; the counts include every workspace.',
        why: 'The subjects the catalogue is organised around. Near-duplicates here are a sign the tags need tidying.',
    },
    dataRequests: {
        title: 'Data requests',
        what: 'Requests to connect data to a workspace.',
        how: 'Requests made in the range, against the same length of time before it. Connected and declined count the requests answered in the range, whenever they were made. Open is every request pending or in progress now.',
        why: 'Each open request is a team waiting for data. A backlog here holds up everything they meant to build.',
    },
    timeToConnect: {
        title: 'Time to connect',
        what: 'How long a data request waited until its data was connected.',
        how: 'For requests connected in the range: when it was connected, minus when it was asked for. The middle value is shown.',
        why: 'The wait between asking for data and having it. If it grows, requests are arriving faster than the platform team can connect them.',
    },
    workspaceRequests: {
        title: 'Workspace requests',
        what: 'Requests for a workspace of one’s own.',
        how: 'Requests submitted in the range, against the same length of time before it. Approved and declined count the decisions made in the range. Open is every request pending now, including those waiting on the person who asked for changes.',
        why: 'Each open request is a team that cannot start yet.',
    },
    timeToDecision: {
        title: 'Time to a decision',
        what: 'How long a workspace request waited for an approval or a decline.',
        how: 'For requests decided in the range: when it was decided, minus when it was first submitted — so any back-and-forth over requested changes is included. The middle value is shown.',
        why: 'The wait before a new team can start. A long one usually means nobody is watching the queue.',
    },
}
