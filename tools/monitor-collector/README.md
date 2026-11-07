# SzroNox monitor collector

Python 3.11 collector for public Facebook and X posts. Source ownership, deduplication, reports and synthesis live in SzroNox; this client keeps only browser profiles and an outbox of unsent API requests.

## Setup

Open PowerShell in this folder:

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
Copy-Item .env.example .env
```

Set `SZRONOX_URL` to the SzroNox origin (or `/api/v1` URL) and `SZRONOX_MONITOR_KEY` to an operator-minted `monitor_collect` key. The key is stored only in the ignored `.env`; never put it in `sources.yaml` or a task argument. `sources.yaml` contains unverified examples only; actual active sources are served by SzroNox.

The collector opens the real installed Chrome in a visible window, or installed Edge if Chrome cannot launch. It does not set a user agent or viewport. Log in once per platform:

```powershell
python -m monitor_collector login facebook
python -m monitor_collector login x
```

The same persistent profile directories are reused on collection. The browser asks for credentials directly; the collector never reads or saves passwords. Run manually with:

```powershell
python -m monitor_collector run
```

`BROWSER_ENGINE=patchright` opts into Patchright with the same installed-browser, visible-window setup. Playwright is the default. `MAX_PROFILES_PER_RUN` (default 4) bounds the number of profiles, `MAX_SCROLLS` (default 8) bounds scrolling, `MAX_POST_AGE_HOURS` defaults to 48, and `MIN_DELAY_SECONDS` / `MAX_DELAY_SECONDS` set randomized pauses. Unsent API requests are retained in the ignored `outbox/requests.json` and replayed in order before a later run.

## Windows Task Scheduler

Run from the same Windows account that completed the Facebook/X logins.

1. Create a task with **Run only when user is logged on** and set **If the task is already running: Do not start a new instance**.
2. Add an **At log on** trigger with a **5 minute delay** and a daily trigger at **07:00**. Both use the same action and persistent profile.
3. Set the action program to the full path to `.venv\Scripts\python.exe`, arguments to `-m monitor_collector run`, and **Start in** to this folder.
4. Leave **Run with highest privileges** off. The collector skips a second successful run on the same Europe/Warsaw date; pass `--force` only for a deliberate manual repeat.

Example manual command:

```powershell
.\.venv\Scripts\python.exe -m monitor_collector run --force
```

## Server cron

Cron needs a logged-in graphical desktop because the browser is intentionally visible. Run it as the account that owns the persistent browser profile, with a valid display session:

```cron
0 7 * * * cd /opt/szronox/tools/monitor-collector && DISPLAY=:0 .venv/bin/python -m monitor_collector run >> logs/cron.log 2>&1
```

Logs are written under `logs/`; parse failures save the rendered HTML and a screenshot under `logs/debug/`. Checkpoints/login walls are logged and skip the affected platform for that run. A failed source does not stop other sources.

## Tests

```powershell
python -m pytest
```
