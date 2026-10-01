# SOURCE-01 + IDEAS-PLAN DEV deployment

Date: 2026-10-01. Operator-authorized deployment to DEV (`https://dev.szronox.zieloni.tech`) only. Master `7ddefcc` (integration `603b9f2` + root correction `7ddefcc`) runs as image `szronox-dev:7ddefcc`, ID `sha256:239dd80f4157178f63b5d8013f15424c6ca7b44c8edf369075b6d6b0908d5cd2`.

Root review: one CORRECTION NEEDED, fixed in `7ddefcc`. `801fba9` made the field display, and `Kopiuj opis` copy, the old manual Źródło during the 30 s `Cofnij` window after `Przywróć automatyczne`, while the server already held the automatic value. Restoring now shows and copies the automatic value immediately; the old text is kept only for `Cofnij`. Spec wording that caused it ("kept in the view") clarified. Web typecheck and the two affected suites (5/5) pass. Everything else accepted: background fetches write only `source_metadata` and only for the owning `requestId` (no `version`/`updated_at` change); idea promotion only on first date assignment, in the same version-checked UPDATE, with the editing timestamp logic using the effective status.

Archive SHA-256 `525cd674a5bb103cc7cbd2bf013a5422c28a29f2daccbcab8f25e5b60a2085c2`, identical after transfer. Backup `backups/pre-7ddefcc/`: 781,792-byte dump (21 TABLE DATA), `runtime.env` (release `57cef02`), state files, build log, SHA256SUMS. 0 queued/running AI runs before rollout.

Rollout: `app` → `app.pre-7ddefcc`; only `SZRONOX_RELEASE` changed; `migrate` (14 checked; 1 applied: `0014_publication_source.sql`); `grants` exit 0; `up -d --no-deps api worker`.

Checks: ready on loopback and HTTPS; `/`, `/sw.js`, `/manifest.webmanifest` 200; api and worker on `7ddefcc`, 0 restarts; `@szronox/source-fetch` resolves inside the API container; both new columns present; all 40 existing Reels have `source_metadata = null` (show `Pobierz`, no backfill); bundle `index-CtnN8Jlm.js` contains `Automatycznie z linku`, `Przywrócono automatyczne źródło`, `Zaplanowanie zmieni status`. Neighbours' StartedAt, Caddy MainPID and Caddyfile hash unchanged.

Live extraction (read-only, from the API container, no DB write): two current OKO.press articles → `found`, `Źródło: Dominika Sitnicka, OKO.press, 01.10.2026` and `Źródło: Paulina Pacuła, OKO.press, 01.10.2026`. `rp.pl` refuses the fetch (`SOURCE_ACCESS_DENIED`, bot blocking) → such Reels end `failed` with the domain line.

Known limitations (not blocking): the 5-minute sweep can fetch a row whose in-process retry timer is also pending (bounded by `attempts < 3`); a crash during the third attempt can leave a row `pending` at 3 attempts, where the UI offers only `Sprawdź` (the refresh endpoint still recovers it).

Open gates: operator browser pass on DEV (Źródło states, undo, copy, planner ideas group, drag of an idea at desktop width), authenticated refresh/CSRF through the browser, Android.

Rollback (code only): restore `app.pre-7ddefcc` as `app` and `backups/pre-7ddefcc/runtime.env`, then `config/dc-gemini.sh up -d --no-deps api worker`. Keep 0014: additive nullable columns; `57cef02` selects explicit columns.
