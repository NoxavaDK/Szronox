# StreamControl ↔ SzroNox — handoff for the streaming PC

Status: **SzroNox side live on DEV since 2026-10-12** (release `2438429`). This brief is for the
Claude session on the streaming PC that works in the **StreamControl** repository (OBS overlays,
host panel, chat/comments, `/signal` dock). Nothing in SzroNox needs to change for this work.

Background and the original plan: `docs/implementation/STREAM-LIVE-01-proposal.md` (written from
the StreamControl side; it lists what StreamControl had already built: `Store.receive`, the queue,
signals, the Tematy / Cytaty / Komentarze tabs, the `/signal` dock and reset).

## What the streaming PC must do

1. **Poller (in `server.py`, background thread, every ~2 s):**
   - On start: `GET {base}/api/v1/live/feed` **without** `after`. It returns no items and the
     current `cursor`, so old broadcasts are never replayed. Keep the cursor in memory (and
     optionally on disk, so a restart in mid-broadcast continues where it was).
   - Then repeatedly: `GET {base}/api/v1/live/feed?after=<cursor>&limit=50`, process the `items`
     in order, store the returned `cursor`.
   - For each item, immediately `POST /api/v1/live/status {id, status: "delivered"}`, then hand it
     to `Store.receive` mapped as follows:

     | SzroNox item (`kind`, fields) | `Store.receive` message |
     | --- | --- |
     | `quote`, `text`, `source` | `{type: 'quote', id, by: authorName, text, source}` |
     | `signal`, `level` `urgent`/`moment` | `{type: 'signal', by: authorName, level}` |
     | `signal_cancel` | `{type: 'signal-cancel', by: authorName}` |

     `authorName` is `NOXAVA` or `SZRON`.
2. **Report what happened**, from the panel's existing actions:

   | Event in StreamControl | `POST /api/v1/live/status` |
   | --- | --- |
   | quote enters the queue | `waiting` |
   | quote shown on screen (by Kuba, or directly when "Szron może pokazywać cytaty od razu" is on) | `shown` |
   | quote rejected | `dismissed` |
   | host clicks the signal dot | `seen` |
   | signal cleared itself after 10 min | `expired` |
   | signal superseded by a newer signal or a cancel from the same person | `replaced` |

   Allowed transitions: `sent→delivered`; quote `delivered→waiting|shown|dismissed`,
   `waiting→shown|dismissed`; signal `delivered→seen|expired|replaced`; `signal_cancel` stays
   `delivered`. Jumping from `sent` straight to a later valid state is accepted. Repeating the
   same status → `204`. Anything else → `422 {reason: 'invalid_transition'}`: log it and move on,
   never retry it.
3. **Offline behaviour:** if SzroNox or the internet is unreachable, retry quietly (back off to
   ~10 s) and show `SzroNox: brak połączenia` in the panel. Topics, quotes typed by Kuba, the
   overlays and chat keep working. Status reports that failed are queued and resent in order.
   `429` → wait for `Retry-After`. `401` → stop polling and show "klucz SzroNox nieprawidłowy".
4. **Configuration:** `obs-topics/data/szronox.json` (must be **Git-ignored**):
   ```json
   { "baseUrl": "https://dev.szronox.zieloni.tech", "deviceKey": "<secret>", "pollSeconds": 2 }
   ```
   The key is never logged and never shown in the panel or the overlays.

## Hard rules for the device key

- Send it only as `Authorization: Bearer <secret>`. Send **no** cookies and **no** `Origin`
  header: SzroNox refuses device requests that carry either, so the calls must come from Python
  (`server.py`), **never from the browser/overlay JavaScript**.
- The key works on exactly two routes, `GET /live/feed` and `POST /live/status`. It cannot read
  Rolki or anything else.
- If it leaks: `revoke` it (below) and create a new one.

## Creating the key (operator, once, on the SzroNox server)

Run this in **your own terminal**, not inside a Claude session, so the secret never enters a
transcript:

```bash
ssh ubuntu@51.195.103.79
cd /opt/szronox-dev/app
sudo /opt/szronox-dev/config/dc-gemini.sh run --rm --no-deps migrate \
  node apps/api/dist/runtime/access-key-cli.js create "StreamControl — PC"
```

It prints `secret (shown once, store it now): …`. Put that value into `szronox.json` on the
streaming PC. Other commands: `… access-key-cli.js list`, `… access-key-cli.js revoke <id>`.

## Acceptance on the streaming PC

1. With a fresh start, no old messages appear (feed starts at "now").
2. Szron sends a quote from `Na żywo` on his phone → it appears in **Cytaty** within ~3 s, and his
   phone shows `Dotarło`, then `W kolejce`. Showing it → `Na ekranie`; rejecting → `Odrzucony`.
3. `Pilnie chcę coś powiedzieć` → red pulsing dot in the panel header and in `/signal`; clicking
   it clears it and his phone shows `Zobaczony`. `Gdy będzie chwila` → yellow; a new signal
   replaces the old one; `Anuluj sygnał` clears it.
4. Pull the network cable for 30 s: the panel says `SzroNox: brak połączenia`; the overlays and
   chat keep working; after reconnecting, the queued messages and status reports catch up in order.
5. The key never appears in logs, the panel, the overlays or Git (`git status`, `git log -p`).
6. Reset ("Wyzeruj postęp") clears the queue and signals but doesn't touch SzroNox.

## Out of scope here

Guests beyond NOXAVA/SZRON (later, needs a new SzroNox amendment); importing stream topics
(`Importuj tematy`) from SzroNox streams, which is a later task; any change to SzroNox itself.
