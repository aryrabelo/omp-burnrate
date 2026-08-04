/**
 * Reads OMP's own quota-polling history (`~/.omp/agent/agent.db`, table `usage_history`)
 * and collapses it to the latest snapshot per account+window.
 *
 * ponytail: read-only `bun:sqlite` query + a Map dedup — no ORM, no migration, no cache.
 */
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

interface RawRow {
	provider: string;
	account_key: string;
	email: string | null;
	account_id: string | null;
	label: string;
	window_label: string | null;
	used_fraction: number | null;
	resets_at: number | null;
	recorded_at: number;
}

const DB_PATH = join(homedir(), ".omp", "agent", "agent.db");

/**
 * `account_id` is the most stable per-account identifier; fall back to email, then provider.
 * Deliberately excludes `account_key`: some providers (kimi-code, zai) rotate a per-poll
 * secret through that column with no per-account meaning, which would otherwise defeat the
 * dedup and flood the snapshot with thousands of phantom "accounts" for the same window.
 */
function dedupKey(row: RawRow): string {
	const account = row.account_id ?? row.email ?? row.provider;
	return `${account}\u0000${row.label}`;
}

/**
 * Latest quota row per (account, label) across every provider/account tracked by OMP.
 * Never throws — a missing/unreadable DB (fresh install, permissions) just yields `[]`.
 */
export function readQuotaSnapshot(): QuotaRow[] {
	if (!existsSync(DB_PATH)) return [];
	let db: Database | null = null;
	try {
		db = new Database(DB_PATH, { readonly: true });
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA query_only = ON");
		const rows = db
			.query(
				`SELECT provider, account_key, email, account_id, label, window_label, used_fraction, resets_at, recorded_at
				 FROM usage_history ORDER BY recorded_at ASC`,
			)
			.all() as RawRow[];
		const latest = new Map<string, QuotaRow>();
		for (const r of rows) {
			latest.set(dedupKey(r), {
				provider: r.provider,
				accountKey: r.account_key,
				email: r.email,
				accountId: r.account_id,
				label: r.label,
				windowLabel: r.window_label,
				usedFraction: r.used_fraction,
				resetsAt: r.resets_at,
				recordedAt: r.recorded_at,
			});
		}
		return [...latest.values()];
	} catch {
		return [];
	} finally {
		db?.close();
	}
}
