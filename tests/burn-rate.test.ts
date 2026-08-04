import { describe, expect, test } from "bun:test";
import {
	buildBucket,
	formatStatusLine,
	groupByAccount,
	parseWindowMs,
	pickIcon,
	pickMostUrgent,
	projectionLabel,
} from "../src/burn-rate";
import type { QuotaRow } from "../src/quota-source";

const HOUR_MS: number = 60 * 60 * 1000;
const DAY_MS: number = 24 * HOUR_MS;

function row(overrides: Partial<QuotaRow> & Pick<QuotaRow, "provider" | "accountKey" | "label">): QuotaRow {
	return {
		email: null,
		accountId: null,
		windowLabel: null,
		usedFraction: 0.5,
		resetsAt: null,
		recordedAt: 1,
		...overrides,
	};
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

	test("returns null for unrecognized free text", () => {
		expect(parseWindowMs("Usage window")).toBeNull();
		expect(parseWindowMs(null)).toBeNull();
		expect(parseWindowMs(undefined)).toBeNull();
	});
});

describe("buildBucket", () => {
	const now = 1_000_000;

	test("no projection when resetsAt is missing", () => {
		const bucket = buildBucket(42, null, 7 * DAY_MS, now);
		expect(bucket.hasProjection).toBe(false);
		expect(bucket.projectedPct).toBe(42);
	});

	test("no projection when windowMs is missing or non-positive", () => {
		expect(buildBucket(42, now + HOUR_MS, null, now).hasProjection).toBe(false);
		expect(buildBucket(42, now + HOUR_MS, 0, now).hasProjection).toBe(false);
		expect(buildBucket(42, now + HOUR_MS, -1, now).hasProjection).toBe(false);
	});

	test("falls back to raw pct when the window has barely started (elapsedPct < 1)", () => {
		// 7-day window, 59 minutes elapsed (~0.58%) — below the 1% floor.
		const windowMs = 7 * DAY_MS;
		const resetsAt = now + windowMs - 59 * 60 * 1000;
		const bucket = buildBucket(10, resetsAt, windowMs, now);
		expect(bucket.hasProjection).toBe(true);
		expect(bucket.projectedPct).toBe(10);
	});

	test("projects usage to the reset moment once enough of the window has elapsed", () => {
		// 10-hour window, 5 hours elapsed (50%), 25% used so far → projects to 50% at reset.
		const windowMs = 10 * HOUR_MS;
		const resetsAt = now + windowMs / 2;
		const bucket = buildBucket(25, resetsAt, windowMs, now);
		expect(bucket.hasProjection).toBe(true);
		expect(bucket.projectedPct).toBeCloseTo(50, 5);
	});
});

describe("projectionLabel", () => {
	test("over at >= 100", () => {
		expect(projectionLabel(100).status).toBe("over");
		expect(projectionLabel(150).status).toBe("over");
	});

	test("near at >= 90 and < 100", () => {
		expect(projectionLabel(90).status).toBe("near");
		expect(projectionLabel(99.9).status).toBe("near");
	});

	test("ok below 90", () => {
		expect(projectionLabel(0).status).toBe("ok");
		expect(projectionLabel(89.9).status).toBe("ok");
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

	test("assigns a stable icon per account, deterministic across calls", () => {
		const first = groupByAccount(rows);
		const second = groupByAccount(rows);
		expect(first.map((g) => g.icon)).toEqual(second.map((g) => g.icon));
		expect(first.find((g) => g.key === "account:aaa")?.icon).toBe(pickIcon("account:aaa"));
	});

	test("guarantees distinct icons for as many accounts as the palette holds (16), even under hash collisions", () => {
		const manyAccounts = Array.from({ length: 16 }, (_, i) =>
			row({ provider: "anthropic", accountKey: "oauth", accountId: `account:${i}`, label: "L" }),
		);
		const icons = groupByAccount(manyAccounts).map((g) => g.icon);
		expect(new Set(icons).size).toBe(16);
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

describe("pickMostUrgent", () => {
	test("picks the window with the highest projected pct, not just the highest raw usedFraction", () => {
		const now = 1_000_000;
		const windowMs = 10 * HOUR_MS;
		const group = {
			key: "acct",
			shortLabel: "acct",
			icon: pickIcon("acct"),
			rows: [
				// Raw 60% used, but window barely started (no projection possible without windowLabel).
				row({ provider: "anthropic", accountKey: "oauth", label: "A", usedFraction: 0.6 }),
				// Raw 25% used, but window half elapsed → projects to 50%, more urgent.
				row({
					provider: "anthropic",
					accountKey: "oauth",
					label: "B",
					windowLabel: "10 Hour",
					usedFraction: 0.25,
					resetsAt: now + windowMs / 2,
				}),
			],
		};
		const pick = pickMostUrgent(group, now);
		expect(pick?.hasProjection).toBe(false);
		expect(pick?.usedPct).toBeCloseTo(60, 5);
	});

	test("skips rows with null usedFraction and returns undefined when none remain", () => {
		const group = {
			key: "acct",
			shortLabel: "acct",
			icon: pickIcon("acct"),
			rows: [row({ provider: "anthropic", accountKey: "oauth", label: "A", usedFraction: null })],
		};
		expect(pickMostUrgent(group, Date.now())).toBeUndefined();
	});
});

describe("formatStatusLine", () => {
	test("returns undefined when there is no quota data", () => {
		expect(formatStatusLine([])).toBeUndefined();
	});

	test("shows the current used% plus pace delta and ETA when a projection is derivable", () => {
		const now = 1_000_000;
		// 10h window, 5h elapsed (50%), 30% used so far → projects to 60% at reset (under pace).
		const rows: QuotaRow[] = [
			row({
				provider: "anthropic",
				accountKey: "oauth",
				accountId: "account:aaa",
				email: "aryrabelo@gmail.com",
				label: "Claude 10 Hour",
				windowLabel: "10 Hour",
				usedFraction: 0.3,
				resetsAt: now + 5 * HOUR_MS,
			}),
		];
		const line = formatStatusLine(rows, now);
		expect(line).toContain("aryrabelo 30%\u{1f7e2}(-40%/5h00m)");
	});

	test("omits pace delta and ETA when no window length is derivable — shows raw used% only", () => {
		const now = 1_000_000;
		const rows: QuotaRow[] = [
			row({ provider: "kimi-code", accountKey: "secret:xyz", label: "Usage window", usedFraction: 0.1 }),
		];
		const line = formatStatusLine(rows, now);
		expect(line).toBe(`${pickIcon("kimi-code:secret:xyz")}kimi-code 10%`);
	});
});
