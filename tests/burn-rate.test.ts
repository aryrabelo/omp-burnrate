import { describe, expect, test } from "bun:test";
import { buildBucket, buildStatusSegments, groupByAccount, paceRatio, parseWindowMs, severityFromRatio } from "../src/burn-rate";
import type { QuotaRow } from "../src/quota-source";

const HOUR_MS: number = 60 * 60 * 1000;
const DAY_MS: number = 24 * HOUR_MS;

function row(overrides: Partial<QuotaRow> & Pick<QuotaRow, "provider" | "accountKey" | "label">): QuotaRow {
	// Object.assign, not a spread literal: spreading a Partial leaves `T | undefined` per key,
	// which fails the QuotaRow return type.
	return Object.assign(
		{
			email: null,
			accountId: null,
			windowLabel: null,
			usedFraction: 0.5,
			resetsAt: null,
			subCap: false,
			recordedAt: 1,
		},
		overrides,
	);
}

describe("parseWindowMs", () => {
	test("parses hour windows", () => {
		expect(parseWindowMs("5 Hour")).toBe(5 * HOUR_MS);
		expect(parseWindowMs("5h limit")).toBe(5 * HOUR_MS);
	});

	test("parses day windows", () => {
		expect(parseWindowMs("7 Day")).toBe(7 * DAY_MS);
	});

	test("parses week and month with no leading integer", () => {
		expect(parseWindowMs("Weekly")).toBe(7 * DAY_MS);
		expect(parseWindowMs("Monthly")).toBe(30 * DAY_MS);
	});

	test("resolves known non-standard labels via alias (kimi-code's mislabeled 7-day window)", () => {
		expect(parseWindowMs("Usage window")).toBe(7 * DAY_MS);
		expect(parseWindowMs("USAGE WINDOW")).toBe(7 * DAY_MS);
	});

	test("returns null for truly unrecognized free text", () => {
		expect(parseWindowMs("something else entirely")).toBeNull();
		expect(parseWindowMs(null)).toBeNull();
		expect(parseWindowMs(undefined)).toBeNull();
	});
});

describe("buildBucket", () => {
	const now = 1_000_000;

	test("no expected baseline when resetsAt is missing", () => {
		const bucket = buildBucket(42, null, 7 * DAY_MS, now);
		expect(bucket.expectedPct).toBeNull();
		expect(bucket.usedPct).toBe(42);
	});

	test("no expected baseline when windowMs is missing or non-positive", () => {
		expect(buildBucket(42, now + HOUR_MS, null, now).expectedPct).toBeNull();
		expect(buildBucket(42, now + HOUR_MS, 0, now).expectedPct).toBeNull();
		expect(buildBucket(42, now + HOUR_MS, -1, now).expectedPct).toBeNull();
	});

	test("no expected baseline when resetsAt is already in the past (stale/dead row)", () => {
		const bucket = buildBucket(4, now - HOUR_MS, 7 * DAY_MS, now);
		expect(bucket.expectedPct).toBeNull();
		expect(bucket.msUntilReset).toBe(0);
	});

	test("stays small right after a reset, unlike a forward ratio projection would explode", () => {
		// 7-day window, 59 minutes elapsed (~0.58%).
		const windowMs = 7 * DAY_MS;
		const resetsAt = now + windowMs - 59 * 60 * 1000;
		const bucket = buildBucket(10, resetsAt, windowMs, now);
		expect(bucket.expectedPct).toBeCloseTo(0.58, 1);
	});

	test("expected tracks elapsed time linearly, independent of usedPct", () => {
		// 10-hour window, 5 hours elapsed → 50% expected regardless of usage.
		const windowMs = 10 * HOUR_MS;
		const resetsAt = now + windowMs / 2;
		const bucket = buildBucket(25, resetsAt, windowMs, now);
		expect(bucket.expectedPct).toBeCloseTo(50, 5);
	});
});

describe("paceRatio", () => {
	test("used/expected when expected is positive", () => {
		expect(paceRatio(70, 100)).toBeCloseTo(0.7, 5);
		expect(paceRatio(130, 100)).toBeCloseTo(1.3, 5);
	});

	test("positive infinity when expected is zero and something was used (max over pace)", () => {
		expect(paceRatio(5, 0)).toBe(Number.POSITIVE_INFINITY);
	});

	test("zero when expected is zero and nothing was used (trivially on pace)", () => {
		expect(paceRatio(0, 0)).toBe(0);
	});
});

describe("severityFromRatio", () => {
	test("green inside the +/-10% tolerance band around the ideal point", () => {
		expect(severityFromRatio(0)).toBe("green");
		expect(severityFromRatio(0.7)).toBe("green");
		expect(severityFromRatio(1.0)).toBe("green");
		expect(severityFromRatio(1.1)).toBe("green");
	});

	test("yellow past the band, up to and including 1.3", () => {
		expect(severityFromRatio(1.11)).toBe("yellow");
		expect(severityFromRatio(1.3)).toBe("yellow");
	});

	test("red past 1.3", () => {
		expect(severityFromRatio(1.31)).toBe("red");
		expect(severityFromRatio(4.6)).toBe("red");
	});
});

describe("groupByAccount", () => {
	// Shaped like the real sample rows: 3 distinct anthropic accounts, differentiated by
	// accountId/email, each with more than one window (limit_id).
	const rows: QuotaRow[] = [
		row({
			provider: "anthropic",
			accountKey: "oauth",
			accountId: "account:aaa",
			email: "aryrabelo@gmail.com",
			label: "Claude 5 Hour",
			windowLabel: "5 Hour",
			usedFraction: 0.2,
		}),
		row({
			provider: "anthropic",
			accountKey: "oauth",
			accountId: "account:aaa",
			email: "aryrabelo@gmail.com",
			label: "Claude 7 Day",
			windowLabel: "7 Day",
			usedFraction: 0.9,
		}),
		row({
			provider: "anthropic",
			accountKey: "oauth",
			accountId: "account:bbb",
			email: "fiamclaude@duaud.io",
			label: "Claude 5 Hour",
			windowLabel: "5 Hour",
			usedFraction: 0.4,
		}),
		row({
			provider: "anthropic",
			accountKey: "oauth",
			accountId: "account:ccc",
			email: "admin@duaud.io",
			label: "Claude 5 Hour",
			windowLabel: "5 Hour",
			usedFraction: 0.1,
		}),
	];

	test("separates 3 distinct anthropic accounts by accountId/email, not by provider", () => {
		const groups = groupByAccount(rows);
		expect(groups).toHaveLength(3);
		expect(groups.map((g) => g.key)).toEqual(["account:aaa", "account:bbb", "account:ccc"]);
	});

	test("keeps every window for an account together in one group", () => {
		const groups = groupByAccount(rows);
		const aaa = groups.find((g) => g.key === "account:aaa");
		expect(aaa?.rows).toHaveLength(2);
	});

	test("derives short label from the email local part", () => {
		const groups = groupByAccount(rows);
		expect(groups.find((g) => g.key === "account:aaa")?.shortLabel).toBe("aryrabelo");
	});

	test("carries the row's provider so a caller can render a provider icon", () => {
		const groups = groupByAccount(rows);
		expect(groups.find((g) => g.key === "account:aaa")?.provider).toBe("anthropic");
	});

	test("falls back to provider+accountKey when accountId and email are both absent", () => {
		const noId = [row({ provider: "kimi-code", accountKey: "secret:abc", label: "Usage window" })];
		const groups = groupByAccount(noId);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.key).toBe("kimi-code:secret:abc");
		expect(groups[0]?.shortLabel).toBe("kimi-code");
	});

	test("truncates long provider names to 10 chars for the short label", () => {
		const longProvider = [row({ provider: "a-very-long-provider-name", accountKey: "k", label: "L" })];
		expect(groupByAccount(longProvider)[0]?.shortLabel).toHaveLength(10);
	});
});

describe("buildStatusSegments", () => {
	test("returns [] when there is no quota data", () => {
		expect(buildStatusSegments([])).toEqual([]);
	});

	test("omits an account whose only bucket has no derivable window (dead/unknown, not shown)", () => {
		const rows: QuotaRow[] = [row({ provider: "kimi-code", accountKey: "secret:xyz", label: "custom cycle", usedFraction: 0.1 })];
		expect(buildStatusSegments(rows, 1_000_000)).toEqual([]);
	});

	test("one live bucket: severity from pace ratio, expected pct from elapsed window", () => {
		const now = 1_000_000;
		// 10h window, 5h elapsed (50% expected), 60% used → ratio 1.2 → yellow. (A green
		// hour-scale bucket would be hidden entirely — see the display-rule tests below.)
		const rows: QuotaRow[] = [
			row({
				provider: "anthropic",
				accountKey: "oauth",
				accountId: "a",
				email: "aryrabelo@gmail.com",
				label: "Claude 10 Hour",
				windowLabel: "10 Hour",
				usedFraction: 0.6,
				resetsAt: now + 5 * HOUR_MS,
			}),
		];
		const segments = buildStatusSegments(rows, now);
		expect(segments).toEqual([
			{ label: "aryrabelo", provider: "anthropic", buckets: [{ label: "Claude 10 Hour", used: 60, expected: 50, severity: "yellow", highlight: false }] },
		]);
	});

	test("drops dead/unknown buckets but keeps live ones for the same account", () => {
		const now = 1_000_000;
		const rows: QuotaRow[] = [
			row({ provider: "anthropic", accountKey: "oauth", accountId: "a", label: "Claude 5 Hour", windowLabel: "5 Hour", usedFraction: 0.6, resetsAt: now + 2.5 * HOUR_MS }),
			// Stale: resetsAt already in the past — no derivable expected baseline.
			row({ provider: "anthropic", accountKey: "oauth", accountId: "a", label: "Claude 7 Day (Sonnet)", windowLabel: "7 Day", usedFraction: 0, resetsAt: now - HOUR_MS }),
		];
		const segments = buildStatusSegments(rows, now);
		expect(segments).toHaveLength(1);
		expect(segments[0]?.buckets).toHaveLength(1);
	});

	test("orders buckets shortest window first", () => {
		const now = 1_000_000;
		const rows: QuotaRow[] = [
			row({ provider: "anthropic", accountKey: "oauth", accountId: "a", label: "Claude 7 Day", windowLabel: "7 Day", usedFraction: 0.13, resetsAt: now + 163 * HOUR_MS }),
			row({ provider: "anthropic", accountKey: "oauth", accountId: "a", label: "Claude 7 Day (Fable)", windowLabel: "7 Day", usedFraction: 0.1, resetsAt: now + 163 * HOUR_MS }),
			row({ provider: "anthropic", accountKey: "oauth", accountId: "a", label: "Claude 5 Hour", windowLabel: "5 Hour", usedFraction: 1.0, resetsAt: now + 0.5 * HOUR_MS }),
			row({ provider: "anthropic", accountKey: "oauth", accountId: "a", label: "Claude 30 Day", windowLabel: "30 Day", usedFraction: 0.05, resetsAt: now + 700 * HOUR_MS }),
		];
		const segments = buildStatusSegments(rows, now);
		expect(segments[0]?.buckets.map((b) => b.label)).toEqual(["Claude 5 Hour", "Claude 7 Day", "Claude 7 Day (Fable)", "Claude 30 Day"]);
	});

	test("real scenario: a healthy 5h bucket is hidden; the over-pace weekly bucket shows, highlighted", () => {
		const now = 1_000_000;
		// 5h bucket: 63% used, 90% of window elapsed → ratio 0.7 → green → dropped (display rule).
		// Weekly bucket: 13% used, only ~2.8% of window elapsed → ratio ~4.6 → red, highlighted.
		const rows: QuotaRow[] = [
			row({
				provider: "anthropic",
				accountKey: "oauth",
				accountId: "a",
				email: "fiamclaude@duaud.io",
				label: "Claude 5 Hour",
				windowLabel: "5 Hour",
				usedFraction: 0.63,
				resetsAt: now + 0.5 * HOUR_MS,
			}),
			row({
				provider: "anthropic",
				accountKey: "oauth",
				accountId: "a",
				email: "fiamclaude@duaud.io",
				label: "Claude 7 Day",
				windowLabel: "7 Day",
				usedFraction: 0.13,
				resetsAt: now + 163.3 * HOUR_MS,
			}),
		];
		const segments = buildStatusSegments(rows, now);
		expect(segments[0]?.buckets).toEqual([
			{ label: "Claude 7 Day", used: 13, expected: 3, severity: "red", highlight: true },
		]);
	});

	test("sorts accounts by worst pace ratio across their buckets, descending", () => {
		const now = 1_000_000;
		const rows: QuotaRow[] = [
			// A: 60% used, 50% elapsed → ratio 1.2, yellow (a green hour bucket would be hidden).
			row({ provider: "p", accountKey: "A", accountId: "a", email: "A@x.io", label: "L", windowLabel: "10 Hour", usedFraction: 0.6, resetsAt: now + 5 * HOUR_MS }),
			// B: 90% used, 50% elapsed → ratio 1.8, red.
			row({ provider: "p", accountKey: "B", accountId: "b", email: "B@x.io", label: "L", windowLabel: "10 Hour", usedFraction: 0.9, resetsAt: now + 5 * HOUR_MS }),
			// C: 70% used, 50% elapsed → ratio 1.4, yellow.
			row({ provider: "p", accountKey: "C", accountId: "c", email: "C@x.io", label: "L", windowLabel: "10 Hour", usedFraction: 0.7, resetsAt: now + 5 * HOUR_MS }),
		];
		const labels = buildStatusSegments(rows, now).map((s) => s.label);
		expect(labels).toEqual(["B", "C", "A"]);
	});
});

describe("buildStatusSegments display rules", () => {
	test("on-pace hour-scale bucket is hidden; off-pace one still shows", () => {
		const now = 1_000_000;
		// 5h window, 20% elapsed → ideal 20%. 10% used → ratio 0.5 → green → dropped.
		const healthy = row({ provider: "zai", accountKey: "z1", label: "5 Hours Token Quota", windowLabel: "5 Hour", usedFraction: 0.1, resetsAt: now + 4 * HOUR_MS });
		expect(buildStatusSegments([healthy], now)).toEqual([]);
		// Same window, 40% used → ratio 2.0 → red → shown, not highlighted.
		const burning = { ...healthy, usedFraction: 0.4 };
		expect(buildStatusSegments([burning], now)[0]?.buckets).toEqual([
			{ label: "5 Hours Token Quota", used: 40, expected: 20, severity: "red", highlight: false },
		]);
	});

	test("week-scale bucket always shows highlighted, even when green", () => {
		const now = 1_000_000;
		// 7d window, half elapsed → ideal 50%. 30% used → ratio 0.6 → green, yet headline.
		const weekly = row({ provider: "anthropic", accountKey: "a", email: "a@x.io", label: "Claude 7 Day", windowLabel: "7 Day", usedFraction: 0.3, resetsAt: now + 3.5 * DAY_MS });
		expect(buildStatusSegments([weekly], now)[0]?.buckets).toEqual([
			{ label: "Claude 7 Day", used: 30, expected: 50, severity: "green", highlight: true },
		]);
	});

	test("week-scale highlight only marks aggregate caps (subCap false), not per-product sub-caps", () => {
		const now = 1_000_000;
		const weekly = (subCap: boolean, label: string): QuotaRow =>
			row({ provider: "anthropic", accountKey: "a", email: "a@x.io", label, windowLabel: "7 Day", usedFraction: 0.3, resetsAt: now + 3.5 * DAY_MS, subCap });
		// Aggregate cap (subCap: false) is the headline; the per-model sub-cap (Fable) shows
		// but stays plain.
		const segments = buildStatusSegments([weekly(false, "Claude 7 Day"), weekly(true, "Claude 7 Day (Fable)")], now);
		expect(segments[0]?.buckets).toEqual([
			{ label: "Claude 7 Day", used: 30, expected: 50, severity: "green", highlight: true },
			{ label: "Claude 7 Day (Fable)", used: 30, expected: 50, severity: "green", highlight: false },
		]);
	});
});
