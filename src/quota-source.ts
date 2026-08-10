/**
 * Reads the live quota snapshot straight from OMP's own CLI (`omp usage --json`) and flattens
 * it to one row per account+limit.
 *
 * ponytail: shell out to the CLI instead of re-reading `~/.omp/agent/agent.db` — the CLI already
 * owns provider fetching, caching and account identity, so there is nothing to reimplement.
 */

export interface QuotaRow {
	provider: string;
	accountKey: string;
	email: string | null;
	accountId: string | null;
	label: string;
	windowLabel: string | null;
	usedFraction: number | null;
	resetsAt: number | null;
	recordedAt: number;
}

interface UsageLimit {
	label: string;
	window?: { label?: string | null; resetsAt?: number | null };
	amount?: { usedFraction?: number | null };
}

interface UsageReport {
	provider: string;
	fetchedAt: number;
	metadata?: { email?: string | null; accountId?: string | null };
	limits?: UsageLimit[];
}

/** Set on the child so a nested `omp` invocation can never re-enter this extension. */
export const CHILD_ENV = "OMP_BURNRATE_CHILD";

/** One row per limit of a single account's report. `ordinal` names accounts of providers that
 * expose no email/id (zai, kimi-code) as `zai#1`, matching the CLI's own "account 1" wording. */
function reportRows(report: UsageReport, ordinal: number): QuotaRow[] {
	const email = report.metadata?.email ?? null;
	const accountId = report.metadata?.accountId ?? null;
	const accountKey = accountId ?? email ?? `${report.provider}#${ordinal}`;
	return (report.limits ?? []).map((limit) => ({
		provider: report.provider,
		accountKey,
		email,
		accountId,
		label: limit.label,
		windowLabel: limit.window?.label ?? null,
		usedFraction: limit.amount?.usedFraction ?? null,
		resetsAt: limit.window?.resetsAt ?? null,
		recordedAt: report.fetchedAt,
	}));
}

/**
 * Live quota rows for every authenticated account across every provider.
 * Never throws — a missing `omp` binary, a non-zero exit or unparseable output all yield `[]`.
 */
export async function readQuotaSnapshot(): Promise<QuotaRow[]> {
	if (process.env[CHILD_ENV]) return [];
	try {
		const proc = Bun.spawn(["omp", "usage", "--json"], {
			stdout: "pipe",
			stderr: "ignore",
			env: { ...process.env, [CHILD_ENV]: "1" },
		});
		const stdout = await new Response(proc.stdout).text();
		if ((await proc.exited) !== 0) return [];
		// Trusted shape: this is OMP's own `usage --json` contract, not third-party input.
		const payload: { reports?: UsageReport[] } = JSON.parse(stdout);
		const reports = payload.reports ?? [];
		const ordinals = new Map<string, number>();
		return reports.flatMap((report) => {
			const ordinal = (ordinals.get(report.provider) ?? 0) + 1;
			ordinals.set(report.provider, ordinal);
			return reportRows(report, ordinal);
		});
	} catch {
		return [];
	}
}
