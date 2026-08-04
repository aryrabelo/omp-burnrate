/**
 * Pure burn-rate math and status-line formatting — no I/O, framework-free, unit-testable.
 *
 * Projection idea (ported from cnx-claude's quota-drift.ts `buildBucket`): extrapolate the
 * current usage pace to the window's reset time. If a window is 30% elapsed and already 30%
 * used, projected = 100% (right on pace to exactly fill the cap at reset).
 */
import type { QuotaRow } from "./quota-source";

const HOUR_MS: number = 60 * 60 * 1000;
const DAY_MS: number = 24 * HOUR_MS;
const WEEK_MS: number = 7 * DAY_MS;
const MONTH_MS: number = 30 * DAY_MS;

/**
 * Distinct per-account icon, deterministic (same account key always maps to the same icon,
 * no config file to maintain as accounts get added/removed) — mirrors what the old Claude Code
 * statusline did with a hardcoded email→icon switch, minus the manual upkeep.
 */
const ACCOUNT_ICONS = ["💻", "💼", "🔈", "🚀", "🛰️", "🧪", "🔋", "🛠️", "🌐", "🎯", "📡", "🧭", "🔬", "⚓", "🎧", "🪁"] as const;

function hashCode(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h >>> 0;
}

/** Stable icon for an account key (same input → same icon, across runs and processes). */
export function pickIcon(key: string): string {
	return ACCOUNT_ICONS[hashCode(key) % ACCOUNT_ICONS.length] as string;
}

/**
 * Assigns each group its preferred icon (`pickIcon`), resolving collisions by linear-probing
 * to the next free palette slot. Deterministic: groups are processed in key-sorted order, so
 * the same set of accounts always yields the same assignment, and every group gets a distinct
 * icon as long as there are no more accounts than palette entries.
 */
function assignIcons(groups: AccountGroup[]): void {
	const used = new Set<number>();
	const sorted = [...groups].sort((a, b) => a.key.localeCompare(b.key));
	for (const group of sorted) {
		let index = hashCode(group.key) % ACCOUNT_ICONS.length;
		for (let probe = 0; probe < ACCOUNT_ICONS.length && used.has(index); probe++) {
			index = (index + 1) % ACCOUNT_ICONS.length;
		}
		used.add(index);
		group.icon = ACCOUNT_ICONS[index] as string;
	}
}

/** Leading-integer-plus-unit parser for free-text window labels ("7 Day", "5 Hour", "Weekly", "Monthly"). */
const WINDOW_UNIT_RE = /^(\d+)?\s*(hour|hr|h|day|d|week|weekly|month|monthly)s?\b/;

/**
 * Derive a window's length in ms from its free-text label. Returns `null` when no leading
 * integer+unit token can be parsed (e.g. "Usage window") — callers must skip projection then.
 */
export function parseWindowMs(windowLabel: string | null | undefined): number | null {
	if (!windowLabel) return null;
	const match = windowLabel.trim().toLowerCase().match(WINDOW_UNIT_RE);
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
	/** Extrapolated pct at reset when a projection was derivable; equals `usedPct` otherwise. */
	projectedPct: number;
	hasProjection: boolean;
	/** Ms until this window resets; 0 when unknown or already passed. */
	msUntilReset: number;
}

/**
 * Ported from cnx-claude's `buildBucket`: projects current pace to the reset moment.
 * No projection (raw pct only) when the window length or reset time is unknown/invalid,
 * or the window has barely started (elapsedPct < 1, where the ratio would explode).
 */
export function buildBucket(usedPct: number, resetsAt: number | null, windowMs: number | null, now: number): Bucket {
	if (resetsAt === null || windowMs === null || windowMs <= 0) {
		return { usedPct, projectedPct: usedPct, hasProjection: false, msUntilReset: 0 };
	}
	const msUntilResetRaw = resetsAt - now;
	const elapsedMs = Math.max(0, windowMs - msUntilResetRaw);
	const elapsedPct = (elapsedMs / windowMs) * 100;
	const projectedPct = elapsedPct >= 1 ? (usedPct / elapsedPct) * 100 : usedPct;
	return { usedPct, projectedPct, hasProjection: true, msUntilReset: Math.max(0, msUntilResetRaw) };
}

/** `90m` / `4h05m` / `2d03h` — human-relative time until reset. Ported from cnx-claude's `formatRelative`. */
export function formatRelative(ms: number): string {
	if (ms <= 0) return "0m";
	const totalMin = Math.round(ms / 60_000);
	const days = Math.floor(totalMin / 1440);
	const hours = Math.floor((totalMin % 1440) / 60);
	const minutes = totalMin % 60;
	if (days > 0) return `${days}d${hours}h`;
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	return `${minutes}m`;
}

export type BurnStatus = "over" | "near" | "ok";

/** Ported from cnx-claude's `projectionLabel`, translated: over(>=100) / near(>=90) / ok. */
export function projectionLabel(displayPct: number): { status: BurnStatus; emoji: string } {
	if (displayPct >= 100) return { status: "over", emoji: "\u{1f534}" };
	if (displayPct >= 90) return { status: "near", emoji: "\u{1f7e1}" };
	return { status: "ok", emoji: "\u{1f7e2}" };
}

export interface AccountGroup {
	/** Grouping identity: `accountId` when present, else `email`, else `provider:accountKey`. */
	key: string;
	/** Local part of the email before `@`, else the provider name — truncated to 10 chars. */
	shortLabel: string;
	/** Deterministic per-account icon — see `pickIcon`. */
	icon: string;
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
			group = { key, shortLabel, icon: "", rows: [] };
			groups.set(key, group);
		}
		group.rows.push(row);
	}
	const list = [...groups.values()];
	assignIcons(list);
	return list;
}

export interface UrgentPick {
	shortLabel: string;
	icon: string;
	usedPct: number;
	projectedPct: number;
	hasProjection: boolean;
	/** Ms until the picked window resets; 0 when unknown. */
	msUntilReset: number;
}

/** Display value for a bucket: the projection when derivable, else the raw used pct. */
function bucketDisplayPct(bucket: Bucket): number {
	return bucket.hasProjection ? bucket.projectedPct : bucket.usedPct;
}

/** Picks the account's single most urgent window: highest projectedPct, else highest raw usedPct. */
export function pickMostUrgent(group: AccountGroup, now: number): UrgentPick | undefined {
	let best: Bucket | undefined;
	for (const row of group.rows) {
		if (row.usedFraction === null) continue;
		const bucket = buildBucket(row.usedFraction * 100, row.resetsAt, parseWindowMs(row.windowLabel), now);
		if (best === undefined || bucketDisplayPct(bucket) > bucketDisplayPct(best)) best = bucket;
	}
	if (!best) return undefined;
	return {
		shortLabel: group.shortLabel,
		icon: group.icon,
		usedPct: best.usedPct,
		projectedPct: best.projectedPct,
		hasProjection: best.hasProjection,
		msUntilReset: best.msUntilReset,
	};
}

/**
 * Full pipeline: quota rows → one combined status-bar string, one segment per distinct
 * account. Each segment shows the CURRENT used pct (bounded, intuitive) plus — when a
 * projection was derivable — how far off pace it is (`+N%`/`-N%` vs the 100% cap at reset)
 * and the time until reset, e.g. `💻aryrabelo 42%🔴(+58%/2h10m)`: 42% used now, but burning
 * fast enough to land 58 points over the cap by the time it resets in 2h10m. `undefined`
 * when there is no quota data to show at all.
 */
export function formatStatusLine(rows: QuotaRow[], now: number = Date.now()): string | undefined {
	const parts: string[] = [];
	for (const group of groupByAccount(rows)) {
		const pick = pickMostUrgent(group, now);
		if (!pick) continue;
		const usedRounded = Math.round(pick.usedPct);
		if (!pick.hasProjection) {
			parts.push(`${pick.icon}${pick.shortLabel} ${usedRounded}%`);
			continue;
		}
		const delta = Math.max(-100, Math.min(999, Math.round(pick.projectedPct) - 100));
		const sign = delta > 0 ? "+" : "";
		const emoji = projectionLabel(pick.projectedPct).emoji;
		const eta = formatRelative(pick.msUntilReset);
		parts.push(`${pick.icon}${pick.shortLabel} ${usedRounded}%${emoji}(${sign}${delta}%/${eta})`);
	}
	return parts.length > 0 ? parts.join(" ") : undefined;
}
