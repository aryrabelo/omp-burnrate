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
(by raw usedPct) a weekly bucket that's actually running well ahead of pace.

```
🟡 🟧aryrabelo  Claude 7 Day            ████████|█████|█░░░░░░░░░░░░░░ 50% used · ideal 37% · reset 16 Sep, 22:59
🔴 🟧aryrabelo  Claude 7 Day (Fable)    ████████|█████|████░░░░░░░░░░░ 59% used · ideal 37% · reset 16 Sep, 22:59
🟡 🟧fiamclaude Claude 7 Day            █████████████|██████|░░░░░░░░░ 68% used · ideal 57% · reset 22 Sep, 14:00
🟡 🟧fiamclaude Claude 7 Day (Fable)    █████████████|██████|░░░░░░░░░ 68% used · ideal 57% · reset 22 Sep, 13:59
```

(In the terminal these rows render **bold** — see the display rules below.)

**The two `|` markers bracket the ideal point's ±10-point tolerance band.** Fill
ending left of the first marker is under pace, between them is on pace, past
the second is over pace — the verdict is readable off the bar itself, and the
leading dot just repeats it.

**Provider icon** disambiguates accounts whose own name gives no hint —
`fiamclaude`, `admin`, and `aryrabelo` all share 🟧 because they're Claude
accounts, while the ✳️ `codex` account is `openai-codex`. Known providers
(`anthropic`, `openai-codex`, `kimi-code`, `zai`) get a recognizable icon; an
unrecognized provider falls back to its first letter circled (Ⓐ..Ⓩ) so it
still gets a distinguishing, deterministic mark.

**Account labels** come from the email local part (`fiamclaude`, `aryrabelo`),
which is what tells same-provider accounts apart. When that local part is a
role inbox (`manager@…`) and the provider has a single account, the label
falls back to the provider's own name — so the lone Codex login reads `codex`,
not `manager`. A provider with several accounts keeps the distinguishing local
part (the three Claude accounts stay `fiamclaude`/`aryrabelo`/`admin`).

**Color is by points over pace** (`usedPct - expectedPct`), not raw
percentage: `expectedPct` is where usage would sit right now if it tracked
the clock exactly (linear, not a forward projection). It is the same gap the
bar draws, so dot and bar never disagree. A ratio (`used / expected`) was used
before and misread both ends of a window: 18% used at 11% elapsed read 1.6× →
red on an account with 82% left, while 100% used at 91% elapsed read 1.099× →
green on an account that was already blocked.

- 🔴 red — more than 20 points ahead of the ideal, or the bucket is exhausted
  (≥ 100% used — no margin left, whatever the clock says).
- 🟡 yellow — more than 10 up to 20 points ahead.
- 🟢 green — within 10 points of the ideal (inside the bar's markers), or under pace.

**Each row ends with its window's reset instant** — `· reset 16 Sep, 22:59`,
in your local timezone (24-hour). The widget is fetched once per session (no
refresh timer), so it shows the absolute reset time rather than a live
countdown that would drift stale as the session runs. Rows whose quota data
carries no reset timestamp simply omit the suffix.

**Display rules:** the long window is the headline. Aggregate week-scale-or-longer
caps (7 Day, Monthly, ... — the account's own cap, not per-product sub-caps
like Fable or Zread) always show and render in the theme's **accent color**
over bold. On-pace (🟢) *short*-window buckets — anything under a day, e.g. a
healthy 5-hour quota — are hidden entirely: while a short window is inside its
tolerance band it's noise, and it reappears the moment it burns past pace
(🟡/🔴). An account whose only live bucket is a healthy short window stays out
of the list until something is actually off. Over-quota rows (🔴, past the
band) render in the theme's **error color** — red font, so trouble is legible
at a glance even among highlighted rows.

**Accounts can be hidden** — `HIDDEN_ACCOUNTS` in `src/main.ts` drops accounts
by short label (email local part, else provider name). It's empty by default;
add a short label there to suppress a permanently-capped or uninteresting
account.

**Segments are sorted by worst points-over-pace** across their buckets, descending
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
