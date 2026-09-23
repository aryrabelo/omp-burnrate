/**
 * Pure burn-rate math and status-line segment building — no I/O, no rendering, framework-free,
 * unit-testable.
 *
 * Expected-usage idea (ported from MegaAgentOs's `expectedFraction`/burn-rate ring,
 * public/js/main.js): compare current usage against a linear, time-proportional baseline
 * instead of extrapolating pace forward. The verdict is the gap `usedPct - expectedPct` in
 * percentage points — the same quantity the bar draws (fill vs. the ±10-point markers). A ratio
 * (`used / expected`) was used before and blew up early in a window: 18% used at 11% elapsed
 * read 1.6× → red on an account with 82% left, while the bar showed it on pace.
 *
 * An account can carry several independent quota buckets at once (a 5-hour window, an overall
 * weekly cap, a per-model weekly sub-cap, ...). Collapsing that down to one "most urgent"
 * number hides whichever bucket didn't win, so every live bucket is surfaced, tagged by window
 * duration, and colored by pace ratio (see main.ts for the render/color layer).
 */
import type { QuotaRow } from "./quota-source";

const HOUR_MS: number = 60 * 60 * 1000;
const DAY_MS: number = 24 * HOUR_MS;
const WEEK_MS: number = 7 * DAY_MS;
const MONTH_MS: number = 30 * DAY_MS;

/** Leading-integer-plus-unit parser for free-text window labels ("7 Day", "5 Hour", "Weekly", "Monthly"). */
const WINDOW_UNIT_RE =
	/^(\d+)?\s*(hour|hr|h|day|d|week|weekly|month|monthly)s?\b/;

/**
 * Known non-standard labels that carry no parseable digit+unit (ported from MegaAgentOs's
 * `WINDOW_SECS` table, public/js/main.js) — e.g. kimi-code's "Total quota" bucket is labelled
 * "Usage window" but is actually a rolling 7-day cycle.
 */
const WINDOW_ALIASES: Record<string, number> = {
	"usage window": WEEK_MS,
};

/**
 * Derive a window's length in ms from its free-text label. Returns `null` when neither a
 * known alias nor a leading integer+unit token can be parsed — callers must skip the expected
 * baseline then.
 */
export function parseWindowMs(
	windowLabel: string | null | undefined,
): number | null {
	if (!windowLabel) return null;
	const normalized = windowLabel.trim().toLowerCase();
	const alias = WINDOW_ALIASES[normalized];
	if (alias !== undefined) return alias;
	const match = normalized.match(WINDOW_UNIT_RE);
	if (!match) return null;
	const count = match[1] ? Number(match[1]) : 1;
	switch (match[2]) {
		case "hour":
		case "hr":
		case "h":
			return count * HOUR_MS;
		case "day":
		case "d":
			return count * DAY_MS;
		case "week":
		case "weekly":
			return count * WEEK_MS;
		case "month":
		case "monthly":
			return count * MONTH_MS;
		default:
			return null;
	}
}

export interface Bucket {
	usedPct: number;
	/** Linear, time-proportional expected pct at this moment; null when the window's duration
	 * or reset time can't be derived, or the reset time is already in the past (stale/dead row). */
	expectedPct: number | null;
	/** Ms until this window resets; 0 when unknown or already passed. */
	msUntilReset: number;
	/** This window's total duration in ms; null when not derivable. */
	windowMs: number | null;
}

/**
 * Ported from MegaAgentOs's `expectedFraction` (public/js/main.js). `expectedPct` is where
 * usage would sit right now if it tracked the clock exactly — compare it against `usedPct` to
 * see how far off an even pace ("ritmo") the account is, without the instability of forward
 * extrapolation.
 */
export function buildBucket(
	usedPct: number,
	resetsAt: number | null,
	windowMs: number | null,
	now: number,
): Bucket {
	if (
		resetsAt === null ||
		windowMs === null ||
		windowMs <= 0 ||
		resetsAt <= now
	) {
		return { usedPct, expectedPct: null, msUntilReset: 0, windowMs: null };
	}
	const msUntilReset = resetsAt - now;
	const elapsedMs = windowMs - msUntilReset;
	const expectedPct = Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));
	return { usedPct, expectedPct, msUntilReset, windowMs };
}

export type Severity = "green" | "yellow" | "red";

/** Percentage-point band around the ideal point — the same half-width main.ts draws as the
 * bar's `|` markers. Within +10 points is on pace, up to +20 is drifting, past that is alarming.
 * Burning slower than ideal is never a warning. */
const OVER_YELLOW = 10;
const OVER_RED = 20;

/**
 * Urgency of one bucket: how many percentage points usage runs ahead of an even pace.
 * An exhausted bucket (>= 100% used) has no margin left at all, whatever the clock says, so it
 * ranks above any live gap.
 */
export function overPace(usedPct: number, expectedPct: number): number {
	if (usedPct >= 100) return Number.POSITIVE_INFINITY;
	return usedPct - expectedPct;
}

/** `red` — exhausted or more than `OVER_RED` points ahead; `yellow` — more than `OVER_YELLOW`;
 * `green` — inside the bar's tolerance band or under pace. */
export function severityFromOverPace(over: number): Severity {
	if (over > OVER_RED) return "red";
	if (over > OVER_YELLOW) return "yellow";
	return "green";
}

export interface AccountGroup {
	/** Grouping identity: `accountId` when present, else `email`, else `provider:accountKey`. */
	key: string;
	/** Display name: the email local part (what distinguishes accounts of one provider), else the
	 * provider name. A role-inbox local part (`manager@…`) on a provider with a single account is
	 * swapped for the provider's own friendly name — `codex`, not `manager`. Truncated to 10. */
	shortLabel: string;
	/** Which provider this account belongs to (`anthropic`, `openai-codex`, `kimi-code`, `zai`,
	 * ...) — accounts named after a person/role (`manager`, `admin`) don't disclose this on
	 * their own, so callers need it to render a provider icon. */
	provider: string;
	rows: QuotaRow[];
}

/** Role-inbox local parts that name a mailbox, not a person — useless as an account label when
 * the provider has just one account (openai-codex logs in as `manager@borabot`). */
const GENERIC_LOCAL_PARTS: Record<string, true> = {
	manager: true,
	admin: true,
	root: true,
	owner: true,
	billing: true,
	support: true,
	account: true,
	user: true,
	bot: true,
};

/** Friendly provider names for the rare account whose own email says nothing. Only consulted in
 * the generic-inbox fallback below, so providers with meaningful emails are untouched. */
const PROVIDER_LABELS: Record<string, string> = {
	"openai-codex": "codex",
	"kimi-code": "kimi",
	anthropic: "claude",
};

function localPart(email: string | null): string | null {
	if (!email) return null;
	return email.split("@")[0] ?? email;
}

/** Groups rows by distinct account so each account's own quota is visible, not just an aggregate. */
export function groupByAccount(rows: QuotaRow[]): AccountGroup[] {
	const groups = new Map<string, AccountGroup>();
	for (const row of rows) {
		const key =
			row.accountId ?? row.email ?? `${row.provider}:${row.accountKey}`;
		let group = groups.get(key);
		if (!group) {
			const base = localPart(row.email) ?? row.provider;
			group = {
				key,
				shortLabel: base.slice(0, 10),
				provider: row.provider,
				rows: [],
			};
			groups.set(key, group);
		}
		group.rows.push(row);
	}
	// A role-inbox label (manager@…) reads better as the provider's own name — but only when that
	// provider has a single account, so a provider with several keeps the distinguishing local part.
	const perProvider = new Map<string, number>();
	for (const g of groups.values())
		perProvider.set(g.provider, (perProvider.get(g.provider) ?? 0) + 1);
	for (const g of groups.values()) {
		const lp = localPart(g.rows[0]?.email ?? null);
		if (
			lp &&
			GENERIC_LOCAL_PARTS[lp.toLowerCase()] &&
			perProvider.get(g.provider) === 1
		) {
			g.shortLabel = (PROVIDER_LABELS[g.provider] ?? g.provider).slice(0, 10);
		}
	}
	return [...groups.values()];
}

export interface QuotaBucketView {
	/** The bucket's own label, e.g. `Claude 7 Day (Fable)`. */
	label: string;
	/** Rounded used pct (0-100+). */
	used: number;
	/** Rounded ideal pct at this instant — where usage "should" be if burned evenly. */
	expected: number;
	severity: Severity;
	/** Week-scale-or-longer window (the slow quota that matters most) — renderers emphasize it. */
	highlight: boolean;
	/** Epoch ms this bucket's window resets, propagated verbatim from the source row; `null`
	 * when the source supplied none. */
	resetsAt: number | null;
}

export interface StatusSegment {
	label: string;
	/** See `AccountGroup.provider` — lets callers render a provider icon. */
	provider: string;
	/** One entry per live bucket (dead/unknown buckets — no derivable expected baseline — are
	 * dropped), ordered shortest window first. */
	buckets: QuotaBucketView[];
}

interface LiveBucket {
	windowMs: number;
	label: string;
	usedPct: number;
	expectedPct: number;
	/** `overPace` — points ahead of an even pace (`+Infinity` when exhausted). */
	over: number;
	/** The row's `subCap` — false marks the account's aggregate cap (the headline quota). */
	subCap: boolean;
	/** The row's `resetsAt`, carried through untouched for renderers. */
	resetsAt: number | null;
}

/** Live (non-dead/unknown) buckets for one account's rows, shortest window first. */
function collectLiveBuckets(group: AccountGroup, now: number): LiveBucket[] {
	const live: LiveBucket[] = [];
	for (const row of group.rows) {
		if (row.usedFraction === null) continue;
		const windowMs = parseWindowMs(row.windowLabel);
		const bucket = buildBucket(
			row.usedFraction * 100,
			row.resetsAt,
			windowMs,
			now,
		);
		if (bucket.expectedPct === null || windowMs === null) continue;
		live.push({
			windowMs,
			label: row.label,
			usedPct: bucket.usedPct,
			expectedPct: bucket.expectedPct,
			over: overPace(bucket.usedPct, bucket.expectedPct),
			subCap: row.subCap,
			resetsAt: row.resetsAt,
		});
	}
	live.sort((a, b) => a.windowMs - b.windowMs);
	return live;
}

/**
 * Full pipeline: quota rows → one segment per distinct account, each carrying every live quota
 * bucket for that account (an account can have several at once — 5h, weekly, a per-model
 * weekly sub-cap). Each bucket is colored by how far usage runs ahead of an even pace, in
 * percentage points, so a heavily-used but on-pace bucket doesn't read as alarming, and an
 * exhausted bucket never reads as healthy.
 *
 * Two display rules live here so callers stay dumb:
 * - On-pace (green) hour-scale buckets (< 1 day) are dropped — a healthy short window is noise,
 *   the long window is the headline. Off-pace short windows still show.
 * - Week-scale-or-longer aggregate caps (non-sub-cap rows — per-product caps like Fable/Zread
 *   are `subCap: true`) carry `highlight: true` — renderers emphasize the weekly bar.
 *
 * Segments are sorted by worst (highest) over-pace gap across their surviving buckets — the
 * account with the hottest single bucket leads. `[]` when there is no quota data to show at
 * all. Framework-free by design: callers own rendering/color (see main.ts).
 */
export function buildStatusSegments(
	rows: QuotaRow[],
	now: number = Date.now(),
): StatusSegment[] {
	const scored: { segment: StatusSegment; worstOver: number }[] = [];
	for (const group of groupByAccount(rows)) {
		const live = collectLiveBuckets(group, now).filter(
			(b) => !(b.windowMs < DAY_MS && severityFromOverPace(b.over) === "green"),
		);
		if (live.length === 0) continue;
		const buckets: QuotaBucketView[] = live.map((b) => ({
			label: b.label,
			used: Math.round(b.usedPct),
			expected: Math.round(b.expectedPct),
			severity: severityFromOverPace(b.over),
			highlight: b.windowMs >= WEEK_MS && !b.subCap,
			resetsAt: b.resetsAt,
		}));
		const worstOver = Math.max(...live.map((b) => b.over));
		scored.push({
			segment: { label: group.shortLabel, provider: group.provider, buckets },
			worstOver,
		});
	}
	scored.sort((a, b) => b.worstOver - a.worstOver);
	return scored.map((s) => s.segment);
}
