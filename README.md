# @aryrabelo/omp-burnrate

An [OMP](https://github.com/oh-my-pi) harness extension that lists per-account
subscription/quota **burn rate** when OMP opens: are you burning faster or
slower than the reset window's pace, for *each* account you run.

## Why

OMP already polls quota usage per provider/account, but its own status
surfaces a single aggregate number. That's not enough when you run several
accounts side by side (3+ Anthropic/Claude accounts, plus Codex/Kimi/Z.AI,
etc.) — you need to see *which* account is about to hit its cap, not just
that *some* account somewhere is at N%.

This extension groups quota rows by account (not just provider), and renders
one line per account bucket — carrying **every live quota bucket that account
has at once** (a 5-hour window, an overall weekly cap, a per-model weekly
sub-cap, ...). Collapsing an account down to a single "most urgent" number
hides whichever bucket didn't win — e.g. a healthy 5-hour bucket can outrank
(by raw usedPct) a weekly bucket that's actually burning 4-5x faster than
pace, because the weekly one is numerically smaller this early in its window.

```
🔴 🟧aryrabelo  Claude 7 Day            ████████|█████|█░░░░░░░░░░░░░░ 50% used · ideal 37%
🔴 🟧aryrabelo  Claude 7 Day (Fable)    ████████|█████|████░░░░░░░░░░░ 59% used · ideal 37%
🟡 🟧fiamclaude Claude 7 Day            █████████████|██████|░░░░░░░░░ 68% used · ideal 57%
🟡 🟧fiamclaude Claude 7 Day (Fable)    █████████████|██████|░░░░░░░░░ 68% used · ideal 57%
```

(In the terminal these rows render **bold** — see the display rules below.)

**The two `|` markers bracket the ideal point's ±10% tolerance band.** Fill
ending left of the first marker is under pace, between them is on pace, past
the second is over pace — the verdict is readable off the bar itself, and the
leading dot just repeats it.

**Provider icon** disambiguates accounts whose own name gives no hint —
`fiamclaude`, `admin`, and `aryrabelo` all share 🟧 because they're Claude
accounts, while a `manager` account would be `openai-codex` (✳️). Known
providers (`anthropic`, `openai-codex`, `kimi-code`, `zai`) get a
recognizable icon; an unrecognized provider falls back to its first letter
circled (Ⓐ..Ⓩ) so it still gets a distinguishing, deterministic mark.

**Color is by pace ratio** (`usedPct / expectedPct` — "ritmo"), not raw
percentage: `expectedPct` is where usage would sit right now if it tracked
the clock exactly (linear, not a forward projection — stable through the
whole window instead of exploding right after a reset). A bucket at 100%
used isn't necessarily red if its window is also almost over (ratio close to
1); a bucket at 13% used can be deep red if only ~3% of its window has
elapsed (ratio ~4.6).

- 🔴 red — pace ratio > 1.3 (burning noticeably faster than the clock).
- 🟡 yellow — pace ratio > 1.1 up to 1.3.
- 🟢 green — pace ratio ≤ 1.1 (inside the ±10% tolerance band, or under pace).

**Display rules:** the long window is the headline. Week-scale-or-longer
buckets (7 Day, Monthly, ...) always show and render **bold**. On-pace (🟢)
*short*-window buckets — anything under a day, e.g. a healthy 5-hour quota —
are hidden entirely: while a short window is inside its tolerance band it's
noise, and it reappears the moment it burns past pace (🟡/🔴). An account
whose only live bucket is a healthy short window stays out of the list until
something is actually off.

**Accounts can be hidden** — `HIDDEN_ACCOUNTS` in `src/main.ts` drops
permanently-capped or uninteresting accounts (`manager` by default) by short
label.

**Segments are sorted by worst pace ratio** across their buckets, descending
— the account with the single hottest bucket leads.

Rendered as one widget **per provider**: the host truncates a single widget at
10 lines, and the full account list runs past that. The lists are cleared on
the first turn so they don't eat screen space all session.

Ported from [MegaAgentOs](https://github.com/aryrabelo/MegaAgentOs)'s
burn-rate ring (`public/js/main.js`).

## Install

From a local checkout (works while the repo is private; installed as a link,
so local edits apply without reinstalling):

```
omp plugin install ~/Sites/omp-burnrate
```

Or from GitHub — requires the repo to be public first:

```
omp plugin install github:aryrabelo/omp-burnrate
```

## Data source

`omp usage --json` — OMP's own live usage CLI, which already owns provider
fetching, caching and account identity. A missing binary, a non-zero exit or
unparseable output is a silent no-op, never a crash. The child process is
marked with `OMP_BURNRATE_CHILD=1` so it can never re-enter this extension.

## Refresh cadence

One fetch per session, on `session_start`. No timer: `omp usage` is itself
polled and cached by OMP, so re-running it on an interval would only spend a
subprocess to redraw the same numbers.
