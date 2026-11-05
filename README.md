# Cursor Daily Credits

A Cursor-compatible extension that reads your signed-in plan and the same percentages shown in Cursor Settings under Plan & Usage, plus the separate weekly Grok Bot meter. It turns the percent still left into a daily allowance, then shows what you used, a bar for each day, and the models behind that usage.

## Features

- No manual balance, plan, or reset-date entry.
- Cursor Models and Other Models match the Plan & Usage meters.
- Grok Bot is shown as its own weekly pool with its own reset date.
- Days left matches the count Cursor shows next to each reset date.
- Today's allowance is the percent still left on each meter, divided by that pool's days left.
- The status bar shows how much of today's allowance has been used.
- A daily bar graph covers the current billing cycle.
- Tables list the models, requests, tokens, and charged amount for today and for the cycle.
- Refreshes every 5 minutes.
- Stores only local daily opening snapshots. It does not send credentials to third-party services or store the token.

## Install

1. Share `cursor-daily-credits-1.5.0.vsix`.
2. In Cursor press `Ctrl+Shift+P`.
3. Run `Extensions: Install from VSIX...` and select the file.
4. Reload Cursor if the extension does not activate.
5. Run `Cursor Daily Credits: Open Dashboard`, or look at the status bar.

## Daily allowance

`daily limit = percent still left / days still left until the reset date`

The plan pools are Cursor Models (Composer / Auto) and Other Models. Grok Bot is a separate weekly allowance from `get-sand-usage-status`, not the same meter as Cursor Models. The opening snapshot for each local day stays fixed, so later refreshes compare against that day's target.

The graph covers every day of the current billing cycle. Each day's used percent is that day's share of the cycle's Plan & Usage percent, weighted by charged amount when Cursor reports one and by requests otherwise. The label on each day is that used percent. A day's allowance is the percent still left at the start of that day, divided by the days left until reset. Usage events are read for the team namespace `Taeya`.

**First check of the day:** the percent "used today" on the meter starts at the first successful sync. Usage events from earlier the same day still appear in the graph and in "What you used today".

## Privacy and compatibility

This is an unofficial integration. Cursor does not document a public API for individual plan usage. The extension reads the local Cursor user ID and access token so it can call Cursor’s dashboard endpoints (`/api/dashboard/get-current-period-usage`, `/api/usage-summary`, and related routes) plus `api2.cursor.sh` as a fallback. It does not upload the token anywhere else. A Cursor update may change these endpoints.

Recent Cursor builds encrypt `cursorAuth/accessToken` at rest as `cursor-safe-storage:v1:`. On Windows the extension unwraps that with Cursor’s OSCrypt key from `Local State` (DPAPI). Without that unwrap, every usage call returns 401.

The extension prefers Node's built-in SQLite reader and falls back to local Python (`python`, `py`, or `python3`) to read Cursor's session database. Use `Cursor Daily Credits: Show Logs` if the live data does not load.
