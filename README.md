# @aryrabelo/omp-burnrate

An [OMP](https://github.com/oh-my-pi) harness extension that shows per-account
subscription/quota **burn rate** directly in the status bar: are you burning
faster or slower than the reset window's pace, for *each* account you run.

## Why

OMP already polls quota usage per provider/account into a local SQLite DB, but
its own status surfaces a single aggregate number. That's not enough when you
run several accounts side by side (3+ Anthropic/Claude accounts, plus
Codex/Kimi/Z.AI, etc.) — you need to see *which* account is about to hit its
cap, not just that *some* account somewhere is at N%.

This extension groups quota rows by account (not just provider), picks each
account's single most urgent window, and renders one segment per account:

```
aryrabelo:62%🟢 fiamclaude:94%🟡 admin:101%🔴 codex:12%🟢
```

- 🟢 `ok` — projected usage at reset is under 90%.
- 🟡 `near` — projected usage at reset is 90–99%.
- 🔴 `over` — projected (or already over) 100% before reset.

The projection extrapolates current pace to the window's reset time
(`usedPct / elapsedPct * 100`), so a window that's early but burning hot shows
red before it's actually near the cap.

## Install

```
omp plugin install github:aryrabelo/omp-burnrate
```

The repo is currently **private** — this only works for the owner
(`aryrabelo`) until it's flipped public.

## Data source

`~/.omp/agent/agent.db`, table `usage_history` — the same quota-polling
history OMP already maintains locally. Read-only; missing or unreadable DB is
a silent no-op (fresh install / no permissions), never a crash.

## Refresh cadence

Renders once on `session_start`, then every 5 minutes — matching OMP's own
quota-polling interval — until `session_shutdown` clears the timer.
