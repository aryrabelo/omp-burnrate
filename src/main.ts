/**
 * @aryrabelo/omp-burnrate — per-account subscription/quota burn-rate in the OMP status bar.
 *
 * Reads OMP's own quota-polling history and renders one `<label>:<pct>%<emoji>` segment per
 * distinct account (not just an aggregate), so running several Anthropic/Claude accounts plus
 * other providers side by side still shows each one's burn rate at a glance.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { formatStatusLine } from "./burn-rate";
import { readQuotaSnapshot } from "./quota-source";

const STATUS_KEY = "burnrate";
/** Matches OMP's own quota-polling cadence elsewhere on this workstation. */
const REFRESH_MS = 5 * 60 * 1000;

/** Render once. Never throws — a bad DB read must not kill the caller or the interval. */
function render(ctx: ExtensionContext): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, formatStatusLine(readQuotaSnapshot()));
	} catch {
		// ponytail: status-bar hiccup is not worth surfacing; next tick retries.
	}
}

export default function burnRateExtension(pi: ExtensionAPI): void {
	let timer: NodeJS.Timeout | undefined;

	pi.on("session_start", (_event, ctx) => {
		render(ctx);
		timer = setInterval(() => render(ctx), REFRESH_MS);
	});

	pi.on("session_shutdown", () => {
		clearInterval(timer);
		timer = undefined;
	});
}
