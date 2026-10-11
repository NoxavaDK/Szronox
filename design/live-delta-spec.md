# LIVE VISUAL DELTA — Na żywo (STREAM-LIVE-01)

Status: **draft for operator approval, 2026-10-11.** Governs only the Na żywo screen and its entry
point. Everything else follows the frozen visual specification. All visible UI is Polish.

Context: used on a phone **during a live broadcast**, often one-handed and under time pressure.
That is the reason for the two explicit exceptions below (full-width signal buttons and a
full-width send button); everything else keeps the compact editorial language.

## A. Entry point

In the `Rolki` header, a quiet text link **`Na żywo`** directly after `Plan`, same style as `Plan`.
Not a status tab, not a floating action. Na żywo uses the same back affordance as `Plan`.

## B. Screen (360 px reference, clean reflow at 320 px)

```
‹ Rolki                     Na żywo
──────────────────────────────────────
SYGNAŁ DLA PROWADZĄCEGO
┌──────────────────────────────────┐
│  ● Pilnie chcę coś powiedzieć     │   urgent  #B42332
└──────────────────────────────────┘
┌──────────────────────────────────┐
│  ● Gdy będzie chwila              │   amber   #8A570C
└──────────────────────────────────┘
Aktywny: Pilnie · 21:04 · Dotarło        Anuluj sygnał
──────────────────────────────────────
CYTAT NA STREAM
[ Wklej zdanie z artykułu            ]
[                                    ]
                                 0/400
[ Źródło (opcjonalnie)               ]
┌──────────────────────────────────┐
│        Wyślij na stream           │   cobalt #315BD8
└──────────────────────────────────┘
──────────────────────────────────────
WYSŁANE
Cytat · „Deficyt wzrośnie o 14…”    Na ekranie · 21:02
Sygnał · Gdy będzie chwila          Zobaczony · 20:51
```

### Signal block

- Section label `SYGNAŁ DLA PROWADZĄCEGO` (11–12 uppercase, secondary text).
- **Exception 1:** two full-width buttons, min height 52 px, 8 px apart, small radius (as inputs),
  white surface with a 1.5 px border in the semantic colour and a leading filled dot in the same
  colour; label in primary text, weight ~600. Not filled, no shadow, no icon besides the dot.
  - `Pilnie chcę coś powiedzieć` — urgent `#B42332`
  - `Gdy będzie chwila` — amber `#8A570C`
- Pressing one sends it immediately (no confirmation: speed matters, and `Anuluj sygnał` undoes
  it). While sending, the pressed button shows `Wysyłanie…` and both are disabled.
- Below, one status line when a signal is active (its latest status is `sent`, `delivered`):
  `Aktywny: Pilnie · 21:04 · Dotarło` (or `Gdy będzie chwila`), with the text action
  `Anuluj sygnał` at the right. The active button additionally shows `✓` after its label, so
  state is never colour-only. Sending the other level replaces the active one.
- When the signal ends, the line reads for 30 s `Zobaczony` / `Wygasł` / `Anulowano`, then
  disappears.

### Quote block

- Section label `CYTAT NA STREAM`.
- Multi-line field, placeholder `Wklej zdanie z artykułu`, 4 visible lines, body 16/23;
  counter `n/400` right-aligned below (secondary; urgent colour plus `Za długi` past 400 — sending
  disabled).
- Single-line field, placeholder `Źródło (opcjonalnie)`, max 120.
- **Exception 2:** full-width cobalt button `Wyślij na stream`, min height 48 px, white label.
  Disabled while the quote field is empty or too long, and while sending (`Wysyłanie…`).
- Success: both fields clear, the row appears at the top of `WYSŁANE`, transient line
  `Wysłano na stream` for 3 s. Failure: fields keep their text, inline line in urgent colour
  `Nie wysłano. Sprawdź połączenie i spróbuj ponownie.`

### WYSŁANE

- Section label `WYSŁANE`; flat rows with thin separators, no cards; the user's own last 20.
- Row: `Cytat · „first ~40 characters…”` or `Sygnał · Pilnie` / `Sygnał · Gdy będzie chwila` /
  `Anulowano sygnał`; right-aligned status label and time `HH:MM`.
- Status labels (plain text, `Na ekranie` in success colour, `Odrzucony` in secondary, others
  primary): `Wysłano`, `Dotarło`, `W kolejce`, `Na ekranie`, `Odrzucony`, `Zobaczony`, `Wygasł`,
  `Zastąpiony`.
- Empty: `Nic jeszcze nie wysłano.` (secondary).

### Refresh and connection

- While the screen is visible the list and active signal refresh every 5 s; refresh stops when
  the page is hidden and runs once on return.
- Failed refresh: one quiet line under the title `Brak połączenia — ponawiam…`; the fields stay
  usable and keep their text.

### Not included

No AI entry points, no editing or deleting sent messages, no other user's messages, no live
comments, no stream topics (STREAM-01).
