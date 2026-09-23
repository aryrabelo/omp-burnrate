/**
 * @aryrabelo/omp-burnrate — per-account subscription/quota burn-rate, listed once when OMP opens.
 *
 * Fetches OMP's own live usage (`omp usage --json`) a single time on `session_start` and renders
 * one line per quota bucket per account, so running several Anthropic/Claude accounts plus other
 * providers side by side still shows each one's burn rate at a glance — including every live
 * bucket an account carries at once (5h window, overall weekly cap, a per-model weekly sub-cap).
 *
 * Each line carries a bar whose two `|` markers bracket the ideal point's +/-10% tolerance band,
 * so pace reads off the bar directly: fill short of the first marker is under pace, between them
 * is on pace, past the second is over pace. A leading color dot repeats that verdict, because the
 * TUI's own text is not styleable from here.
 *
 * One widget per provider: the host caps a single widget at 10 lines ("... (widget truncated)"),
 * and the full account list runs past that.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	buildStatusSegments,
	type QuotaBucketView,
	type Severity,
	type StatusSegment,
} from "./burn-rate";
import { readQuotaSnapshot } from "./quota-source";

/** Widget keys are `burnrate:<provider>` — kept so every one of them can be cleared later. */
const KEY_PREFIX = "burnrate:";

/** Pace verdict at a glance. */
const SEVERITY_DOT: Record<Severity, string> = {
	green: "🟢",
	yellow: "🟡",
	red: "🔴",
};

/** Accounts deliberately hidden: permanently-capped or otherwise uninteresting, matched on the
 * short label (email local part, else provider name). Empty now — the `manager` account it once
 * hid is the live openai-codex quota (email `manager@…`), so hiding it dropped Codex entirely. */
const HIDDEN_ACCOUNTS: Record<string, true> = {};

/** Known-provider icons, so accounts sharing a provider are visually grouped even when their
 * own names (person/role) give no hint. Unknown providers fall back to a circled first letter
 * (Ⓐ..Ⓩ), so a brand-new provider still gets a distinguishing, deterministic mark. */
const PROVIDER_ICONS: Record<string, string> = {
	anthropic: "🟧",
	"openai-codex": "✳️",
	"kimi-code": "🌙",
	zai: "⚡",
};

function providerIcon(provider: string): string {
	const known = PROVIDER_ICONS[provider];
	if (known) return known;
	const code = provider.toUpperCase().charCodeAt(0);
	return code >= 65 && code <= 90
		? String.fromCodePoint(0x24b6 + (code - 65))
		: "▪";
}

/** Bar width in cells, excluding the two `|` markers. */
const BAR_CELLS = 28;
/** Half-width of the on-pace tolerance band, in percentage points. */
const BAND_PCT = 10;

/** Emphasis for highlighted rows (week-scale quotas): theme accent color over ANSI bold.
 * Both are plain SGR escapes — measured zero-width in pi-tui rows (2026-08-28, raw pty
 * capture), so column alignment computed on the visible text is unaffected. */
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";
/** Structural type instead of importing Theme: survives minor API shuffles. */
type ThemeLike = { fg: (color: string, text: string) => string };

/**
 * `████████|██░|░░░░░░` — fill is actual usage, the two `|` bracket the ideal point's +/-10%
 * tolerance band. Usage ending left of the first marker is under pace, past the second is over.
 */
function renderBar(used: number, expected: number): string {
	const cell = (pct: number): number =>
		Math.min(BAR_CELLS, Math.max(0, Math.round((pct / 100) * BAR_CELLS)));
	const cells: string[] = Array.from({ length: BAR_CELLS }, (_, i) =>
		i < cell(used) ? "█" : "░",
	);
	// Splice the upper marker first so the lower insertion cannot shift it.
	cells.splice(cell(expected + BAND_PCT), 0, "|");
	cells.splice(cell(expected - BAND_PCT), 0, "|");
	return cells.join("");
}

const RESET_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Render a reset timestamp in the operator's local timezone, omitting malformed metadata. */
function formatResetAt(resetsAt: number | null): string {
	if (resetsAt === null || !Number.isFinite(resetsAt)) return "";
	const date = new Date(resetsAt);
	if (!Number.isFinite(date.getTime())) return "";
	const month = RESET_MONTHS[date.getMonth()];
	if (month === undefined) return "";
	const minute = String(date.getMinutes()).padStart(2, "0");
	return ` · reset ${date.getDate()} ${month}, ${String(date.getHours()).padStart(2, "0")}:${minute}`;
}

/**
 * `dot account label bar used% · ideal N%` lines, grouped into one entry per provider (worst
 * pace first). Text columns are padded across ALL providers, so bars and markers stay aligned
 * between widgets, not just inside one.
 */

/** One widget row: error-colored when over pace, accent over bold for aggregate weekly caps,
 * plain otherwise. */
function renderBucketLine(
	b: QuotaBucketView,
	who: string,
	labelWidth: number,
	paint: (color: string, text: string) => string,
): string {
	const line = `${SEVERITY_DOT[b.severity]} ${who} ${b.label.padEnd(labelWidth)} ${renderBar(b.used, b.expected)} ${b.used}% used · ideal ${b.expected}%${formatResetAt(b.resetsAt)}`;
	if (b.severity === "red") return paint("error", line);
	if (b.highlight) return paint("accent", BOLD_ON + line + BOLD_OFF);
	return line;
}
function renderLists(
	segments: StatusSegment[],
	theme: ThemeLike | undefined,
): Map<string, string[]> {
	const nameWidth = Math.max(...segments.map((s) => s.label.length));
	const labelWidth = Math.max(
		...segments.flatMap((s) => s.buckets.map((b) => b.label.length)),
	);
	const paint = (color: string, text: string): string =>
		theme?.fg ? theme.fg(color, text) : text;
	const byProvider = new Map<string, string[]>();
	for (const segment of segments) {
		const who = `${providerIcon(segment.provider)}${segment.label.padEnd(nameWidth)}`;
		const lines = byProvider.get(segment.provider) ?? [];
		for (const b of segment.buckets) {
			lines.push(renderBucketLine(b, who, labelWidth, paint));
		}
		byProvider.set(segment.provider, lines);
	}
	return byProvider;
}

/**
 * Fetch and render once. Never throws — a failed `omp usage` call must not kill the session.
 *
 * ponytail: one live fetch per session, no refresh timer — `omp usage` is itself polled and
 * cached by OMP, so re-running it on an interval would spend a subprocess to redraw the same
 * numbers. Restart the session (or run `omp usage`) for a fresher read.
 */
async function render(ctx: ExtensionContext, keys: Set<string>): Promise<void> {
	try {
		const segments = buildStatusSegments(await readQuotaSnapshot()).filter(
			(s) => !HIDDEN_ACCOUNTS[s.label],
		);
		if (segments.length === 0) return;
		// print/headless UIs may not expose a theme; rows degrade to plain/bold-only.
		const theme = ctx.ui.theme as ThemeLike | undefined;
		for (const [provider, lines] of renderLists(segments, theme)) {
			const key = `${KEY_PREFIX}${provider}`;
			keys.add(key);
			ctx.ui.setWidget(key, lines, { placement: "aboveEditor" });
		}
	} catch {
		// ponytail: a status-bar hiccup is not worth surfacing.
	}
}

export default function burnRateExtension(pi: ExtensionAPI): void {
	const keys = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		void render(ctx, keys);
	});

	// The opening snapshot has served its purpose once the user starts working — drop the lists
	// so they do not eat screen space all session.
	pi.on("turn_start", (_event, ctx) => {
		for (const key of keys) ctx.ui.setWidget(key, undefined);
		keys.clear();
	});
}
