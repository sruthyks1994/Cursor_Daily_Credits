# Cursor Daily Credits

A Cursor-compatible extension that reads your signed-in plan and the same percentages shown in Cursor Settings under Plan & Usage. It turns the percent still left into a daily allowance, then shows what you used, a bar for each day, and the models behind that usage.

## Features

- No manual balance, plan, or reset-date entry.
- Cursor Models and Other Models match the Plan & Usage meters.
- Days left matches the count Cursor shows next to the reset date.
- Today's allowance is the percent still left on each meter, divided by the days left.
- The status bar shows how much of today's allowance has been used.
- A daily bar graph covers the current billing cycle.
- Tables list the models, requests, tokens, and charged amount for today and for the cycle.
- Refreshes every 5 minutes.
- Stores only local daily opening snapshots. It does not send credentials to third-party services or store the token.

## Install

1. Share `cursor-daily-credits-1.3.9.vsix`.
2. In Cursor press `Ctrl+Shift+P`.
3. Run `Extensions: Install from VSIX...` and select the file.
4. Reload Cursor if the extension does not activate.
5. Run `Cursor Daily Credits: Open Dashboard`, or look at the status bar.

## Daily allowance

`daily limit = percent still left / days still left until the reset date`

The two pools are Cursor Models (includes Cursor Grok and Composer) and Other Models. The opening snapshot for each local day stays fixed, so later refreshes compare against that day's target.

The graph covers every day of the current billing cycle. Each day's used percent is that day's share of the cycle's Plan & Usage percent, weighted by charged amount when Cursor reports one and by requests otherwise. The label on each day is that used percent. A day's allowance is the percent still left at the start of that day, divided by the days left until reset. Usage events are read for the team namespace `Taeya`.

**First check of the day:** the percent "used today" on the meter starts at the first successful sync. Usage events from earlier the same day still appear in the graph and in "What you used today".

## Privacy and compatibility

This is an unofficial integration. Cursor does not document a public API for individual plan usage. The extension reads the local Cursor user ID and access token so it can call `cursor.com` and `api2.cursor.sh`. It does not upload the token anywhere else. A Cursor update may change these endpoints.

The extension prefers Node's built-in SQLite reader and falls back to local Python (`python`, `py`, or `python3`) to read Cursor's session database. Use `Cursor Daily Credits: Show Logs` if the live data does not load.
