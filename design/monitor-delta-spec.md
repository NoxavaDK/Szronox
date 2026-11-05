# MONITOR VISUAL DELTA — Monitoring (MONITOR-01)

Status: **proposal for operator review, 5 November 2026.** Governs only the Monitoring screen, its
Źródła view and its entry point. Everything else follows `design/frozen-visual-spec.md`. All
visible UI is Polish. Contract: T00 section MONITOR-01.

Context: read in the morning on a phone (Android, 360 px reference) or a desktop window, to see
what the monitored parties posted and to pick filmiki topics. Reading density matters more than
actions. Compact editorial language throughout; no exceptions to the frozen rules are requested.

## A. Entry point

In the `Rolki` header, a quiet text link **`Monitoring`** after the existing links (`Plan`,
`Streamy` when present, `Na żywo`), same style. Below 380 px the header links may wrap onto a
second line under the title; they never truncate or scroll. Monitoring uses the same back
affordance as `Plan` (`‹ Rolki`).

## B. Monitoring screen

```
‹ Rolki                Monitoring        Źródła
────────────────────────────────────────────────
‹   czw., 5 listopada   ›
Raport    Posty 42
────────────────────────────────────────────────
Raport · 42 posty · gotowy 07:14     Kopiuj raport
⚠ 2 źródła nie zebrane                         ›
────────────────────────────────────────────────
GŁÓWNE TEMATY
Ceny energii przed zimą
Konfederacja i KKP łączą podwyżki z polityką
klimatyczną UE; Braun dodaje wątek „suwerenności”.
Posty 1 · 2 · 3
────────────────────────────────────────────────
POWTARZANE PRZEKAZY
• „Bruksela płaci, Polacy marzną” — Konfederacja,
  KKP/Braun · Posty 1 · 4
────────────────────────────────────────────────
RÓŻNICE MIĘDZY GRUPAMI
KKP/Braun  Ostrzejszy ton, wątki antyukraińskie. Post 6
────────────────────────────────────────────────
CYTATY
│ „Zielony Ład to podatek od biednych.”
│ Opinia · Konfederacja · Post 2
────────────────────────────────────────────────
POMYSŁY NA FILMIKI
Kto naprawdę płaci za CO2?
Sprawdzić liczby z postów 1 i 3 z danymi URE.  Posty 1 · 3
```

### Day and tabs

- Date stepper under the header: `‹ czw., 5 listopada ›` (weekday short, day, month in Polish
  genitive), 44 px targets. `›` is disabled on today (Europe/Warsaw). Default: today.
- Two underline tabs in the status-selector style: `Raport` and `Posty <n>`, where n = the day's
  post count. Selected tab and date are kept when returning from Źródła or from a Reel.

### Raport tab

- Status line (metadata 12–13, secondary): `Raport · 42 posty · gotowy 07:14`, with the text
  action `Kopiuj raport` right-aligned. Copying writes the report as plain Markdown-style text with
  every post reference expanded to its URL; no persistence; on clipboard failure the inline line
  `Nie udało się skopiować.` replaces the action for 3 s.
- States:
  - queued/running: `Przygotowuję raport…` (secondary). If an earlier result exists it stays
    visible below.
  - failed: `Raport się nie udał.` (urgent) and the text action `Spróbuj ponownie`.
  - no report for that day: `Brak raportu z tego dnia.` and the action `Przygotuj raport` when
    the day has posts; nothing else.
  - succeeded: the action `Wygeneruj ponownie` sits at the end of the report as a quiet text
    action, never at the top.
- Collection strip, only when at least one active source was not `ok` that day:
  `⚠ <n> źródła nie zebrane ›` in the attention-strip style. Tapping expands a flat list in place:
  `Konfederacja · X · Wymaga logowania`. Status labels: `Zebrano`, `Wymaga logowania`,
  `Nie odczytano strony`, `Błąd`, `Nie dziś` (not visited). `Wymaga logowania` is urgent colour
  plus the text, never colour only.
- Sections in this order, each with an uppercase section label and thin separators, no cards:
  `GŁÓWNE TEMATY`, `POWTARZANE PRZEKAZY`, `RÓŻNICE MIĘDZY GRUPAMI`, `CYTATY`,
  `POMYSŁY NA FILMIKI`. An empty section is omitted.
  - Topic and idea titles 16/21 weight ~600; summaries and angles 16/23.
  - Post references are compact cobalt text links `Posty 1 · 2 · 3` using the post numbers
    defined under Posty. Tapping one switches to `Posty` (clearing filters if they hide it), loads
    further pages until the row is present, scrolls to it and briefly highlights it (background
    `#F7F7F5` → surface, 1.5 s). Never opens the external site directly.
  - Quotes: 2 px left rule in divider colour, quote text 16/23 in Polish quotation marks, then
    one metadata line `Opinia · Konfederacja · Post 2`. Labels: `Fakt`, `Opinia`, `Mieszane`.
- Per-post fact/opinion labels are not a report section; they appear on post rows (below).

### Posty tab

```
Wszystkie  Konfederacja  KKP/Braun      FB  X
────────────────────────────────────────────────
1  Konfederacja · X · 07:41          Opinia
   Rachunki za prąd znowu w górę, a rząd
   tłumaczy się Brukselą. Ile jeszcze…   Więcej
   2 zdjęcia · 1,2 tys. polubień · 84 odp.
   Otwórz post                        Zrób rolkę
────────────────────────────────────────────────
2  Grzegorz Braun · X · Repost · 06:58
   …
```

- Filter row: group chips (`Wszystkie` + each group label of active sources), then platform
  toggles `FB` / `X` (both on by default). Horizontally scrollable on narrow screens; selected
  chip with cobalt underline like status tabs, not filled pills.
- Flat rows, thin separators, newest first. Each post carries a day number: its order of first
  sighting within the day (1 = first seen). Numbers never shift when later posts arrive and are
  kept under filters; the report uses the same numbers.
  - Line 1 (metadata 12–13): number, source name, `FB`/`X`, `Repost` and `Przypięty` when set,
    then time: `published` time as `HH:MM` (or `d mmm HH:MM` when not that day); when unknown,
    `widziany HH:MM` in secondary. Right-aligned label from the report (`Fakt` / `Opinia` /
    `Mieszane`) when present.
  - Text: body 16/23, clamped to 3 lines with the text action `Więcej` / `Mniej`. A repost's text
    is shown in secondary colour.
  - Metadata line (secondary 12–13): media counts (`2 zdjęcia`, `1 wideo`, Polish plural forms)
    and the visible engagement values exactly as stored, joined by ` · `. Omitted when empty.
  - Actions row: `Otwórz post` (opens the original in a new tab) left; `Zrób rolkę` right as a
    cobalt text action. While creating: `Tworzę…`. After success the action is replaced by
    `Rolka utworzona · Otwórz` (opens Reel Detail). On failure an inline urgent line
    `Nie utworzono rolki. Spróbuj ponownie.` A post that already has a Reel always shows
    `Rolka utworzona · Otwórz`.
- 50 rows per page, then the text action `Pokaż więcej` at the end.
- Empty: `Brak postów z tego dnia.` With filters: `Brak postów dla tych filtrów.` + `Wyczyść`.

## C. Źródła view

Opened by the `Źródła` text link in the Monitoring header; full screen with `‹ Monitoring`.

```
‹ Monitoring               Źródła     + Dodaj
────────────────────────────────────────────────
KONFEDERACJA
Konfederacja                                 X
x.com/KONFEDERACJA_      Zebrano · dziś 07:10
────────────────────────────────────────────────
Konfederacja                          Facebook
facebook.com/Konfederacja   Wymaga logowania
────────────────────────────────────────────────
KKP/BRAUN
…
WYŁĄCZONE
Stary profil (secondary)                     X
```

- Sources grouped by group label (section labels uppercase), alphabetical; inactive sources
  collected at the end under `WYŁĄCZONE` in secondary colour.
- Row: name (16/21 ~600) with platform at right (`Facebook` / `X`); second line the profile URL
  without `https://` and `www.` (secondary, truncated with ellipsis), and the last status with
  date: `Zebrano · dziś 07:10`, `Wymaga logowania`, `Nie odczytano strony`, `Błąd`, or
  `Jeszcze nie zbierano`.
- `+ Dodaj` (cobalt text action, header right) and tapping a row open the same form, in place of
  the list on phones and as a right-hand panel from 760 px:
  - `Nazwa` (max 120), `Grupa` (max 80, free text with the existing group labels offered as
    tappable suggestions under the field), `Platforma` (two-option segmented control
    `Facebook` / `X`, fixed once saved, shown as text when editing), `Adres profilu` (full URL).
  - Actions: `Zapisz` (cobalt text action, disabled until valid) and `Anuluj`. When editing, a
    secondary text action `Wyłącz źródło` / `Włącz źródło` at the bottom. No delete.
  - Inline validation (urgent colour, under the field): `Podaj pełny adres zaczynający się od
    https://`, `To źródło już jest na liście.`, `Ktoś zmienił to źródło. Odśwież i spróbuj
    ponownie.` (version conflict).
- Empty list: `Nie dodano jeszcze żadnych źródeł.` + `Dodaj pierwsze źródło`.

## D. Sizing, refresh and connection

- 320 px up to desktop. Below 760 px one column. From 760 px the content is capped at ~720 px
  and centred (reading width); the Źródła form becomes a right panel as above. No horizontal page
  scrolling at any width; touch targets ~44 px.
- Data loads on open and on return to a visible page. While the day's report is queued or
  running, the report refreshes every 10 s; otherwise no polling.
- Failed load: one quiet line under the header `Brak połączenia — ponawiam…`; already loaded
  content stays visible.

## E. Not included

No charts, counts over time or analytics; no notifications; no editing or deleting posts; no
comments under posts; no downloaded media or previews of images/videos (links only); no AI
actions besides `Wygeneruj ponownie` / `Przygotuj raport`; no automatic Reels.
