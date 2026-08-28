/**
 * Pure burn-rate math and status-line segment building — no I/O, no rendering, framework-free,
 * unit-testable.
 *
 * Expected-usage idea (ported from MegaAgentOs's `expectedFraction`/burn-rate ring,
 * public/js/main.js): compare current usage against a linear, time-proportional baseline
 * instead of extrapolating pace forward. `usedPct / expectedPct` ("ritmo"/pace ratio) is
 * stable through the whole window — unlike a forward ratio projection, it can't explode right
 * after a reset, because the denominator only ever shrinks toward 100, never toward 0.
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
const WINDOW_UNIT_RE = /^(\d+)?\s*(hour|hr|h|day|d|week|weekly|month|monthly)s?\b/;

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
export function parseWindowMs(windowLabel: string | null | undefined): number | null {
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
export function buildBucket(usedPct: number, resetsAt: number | null, windowMs: number | null, now: number): Bucket {
	if (resetsAt === null || windowMs === null || windowMs <= 0 || resetsAt <= now) {
		return { usedPct, expectedPct: null, msUntilReset: 0, windowMs: null };
	}
	const msUntilReset = resetsAt - now;
	const elapsedMs = windowMs - msUntilReset;
	const expectedPct = Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));
	return { usedPct, expectedPct, msUntilReset, windowMs };
}

export type Severity = "green" | "yellow" | "red";

/**
 * Pace-ratio band ("ritmo"): a +/-10% tolerance around the ideal point. At or under +10% is on
 * pace, up to +30% is drifting, past that is alarming. The -10% edge needs no threshold —
 * burning slower than ideal is never a warning.
 */
const PACE_YELLOW = 1.1;
const PACE_RED = 1.3;

/**
 * `usedPct / expectedPct` — how many times faster than an even pace this bucket is burning.
 * 0.7 reads "burning at 70% of the expected pace" (plenty of room); 1.3 reads "30% hotter than
 * expected". `expectedPct <= 0` (right at/before a reset) is a division-by-zero edge case,
 * resolved directly: any usage at all is maximally over pace, none is trivially on pace.
 */
export function paceRatio(usedPct: number, expectedPct: number): number {
	if (expectedPct <= 0) return usedPct > 0 ? Number.POSITIVE_INFINITY : 0;
	return usedPct / expectedPct;
}

/** `red` — pace ratio past `PACE_RED`; `yellow` — past `PACE_YELLOW` but not `PACE_RED`; `green` — at or under pace. */
export function severityFromRatio(ratio: number): Severity {
	if (ratio > PACE_RED) return "red";
	if (ratio > PACE_YELLOW) return "yellow";
	return "green";
}

export interface AccountGroup {
	/** Grouping identity: `accountId` when present, else `email`, else `provider:accountKey`. */
	key: string;
	/** Local part of the email before `@`, else the provider name — truncated to 10 chars. */
	shortLabel: string;
	/** Which provider this account belongs to (`anthropic`, `openai-codex`, `kimi-code`, `zai`,
	 * ...) — accounts named after a person/role (`manager`, `admin`) don't disclose this on
	 * their own, so callers need it to render a provider icon. */
	provider: string;
	rows: QuotaRow[];
}

/** Groups rows by distinct account so each account's own quota is visible, not just an aggregate. */
export function groupByAccount(rows: QuotaRow[]): AccountGroup[] {
	const groups = new Map<string, AccountGroup>();
	for (const row of rows) {
		const key = row.accountId ?? row.email ?? `${row.provider}:${row.accountKey}`;
		let group = groups.get(key);
		if (!group) {
			const shortLabel = (row.email ? (row.email.split("@")[0] ?? row.email) : row.provider).slice(0, 10);
			group = { key, shortLabel, provider: row.provider, rows: [] };
			groups.set(key, group);
		}
		group.rows.push(row);
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
	ratio: number;
}

/** Live (non-dead/unknown) buckets for one account's rows, shortest window first. */
function collectLiveBuckets(group: AccountGroup, now: number): LiveBucket[] {
	const live: LiveBucket[] = [];
	for (const row of group.rows) {
		if (row.usedFraction === null) continue;
		const windowMs = parseWindowMs(row.windowLabel);
		const bucket = buildBucket(row.usedFraction * 100, row.resetsAt, windowMs, now);
		if (bucket.expectedPct === null || windowMs === null) continue;
		live.push({
			windowMs,
			label: row.label,
			usedPct: bucket.usedPct,
			expectedPct: bucket.expectedPct,
			ratio: paceRatio(bucket.usedPct, bucket.expectedPct),
		});
	}
	live.sort((a, b) => a.windowMs - b.windowMs);
	return live;
}

/**
 * Full pipeline: quota rows → one segment per distinct account, each carrying every live quota
 * bucket for that account (an account can have several at once — 5h, weekly, a per-model
 * weekly sub-cap). Each bucket is colored by pace ratio, not raw percentage, so a heavily-used
 * but genuinely on-pace bucket doesn't read as alarming next to a lightly-used bucket burning
 * far ahead of pace.
 *
 * Two display rules live here so callers stay dumb:
 * - On-pace (green) hour-scale buckets (< 1 day) are dropped — a healthy short window is noise,
 *   the long window is the headline. Off-pace short windows still show.
 * - Week-scale-or-longer buckets carry `highlight: true` — renderers emphasize the weekly bar.
 *
 * Segments are sorted by worst (highest) pace ratio across their surviving buckets — the
 * account with the hottest single bucket leads. `[]` when there is no quota data to show at
 * all. Framework-free by design: callers own rendering/color (see main.ts).
 */
export function buildStatusSegments(rows: QuotaRow[], now: number = Date.now()): StatusSegment[] {
	const scored: { segment: StatusSegment; worstRatio: number }[] = [];
	for (const group of groupByAccount(rows)) {
		const live = collectLiveBuckets(group, now).filter(
			(b) => !(b.windowMs < DAY_MS && severityFromRatio(b.ratio) === "green"),
		);
		if (live.length === 0) continue;
		const buckets: QuotaBucketView[] = live.map((b) => ({
			label: b.label,
			used: Math.round(b.usedPct),
			expected: Math.round(b.expectedPct),
			severity: severityFromRatio(b.ratio),
			highlight: b.windowMs >= WEEK_MS,
		}));
		const worstRatio = Math.max(...live.map((b) => b.ratio));
		scored.push({ segment: { label: group.shortLabel, provider: group.provider, buckets }, worstRatio });
	}
	scored.sort((a, b) => b.worstRatio - a.worstRatio);
	return scored.map((s) => s.segment);
}
