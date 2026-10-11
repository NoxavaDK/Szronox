# LIVE VISUAL DELTA — Na żywo (STREAM-LIVE-01)

Status: **approved by the operator 2026-10-11** (with the sizing and label corrections below). Governs only the Na żywo screen and its entry
point. Everything else follows the frozen visual specification. All visible UI is Polish.

Context: used **during a live broadcast**, typically in a **small browser window** placed beside
other work on a desktop (Szron shrinks it so it does not take the whole screen), sometimes on a
phone. Fast, unmistakable actions under time pressure are the reason for the two explicit
exceptions below (full-width signal buttons and a full-width send button); everything else keeps
the compact editorial language.

## A. Entry point

In the `Rolki` header, a quiet text link **`Na żywo`** directly after `Plan`, same style as `Plan`.
Not a status tab, not a floating action. Na żywo uses the same back affordance as `Plan`.

## B. Screen

**Sizing (operator correction).** Modular and fluid, not phone-only. Reference: a small browser
window about **360–480 px wide and possibly only ~600 px tall**. It must work from 320 px up to a
full desktop window:

- below 760 px: one column in the order shown below; compact vertical rhythm (section gaps
  ~16 px) so signal and quote blocks fit in ~600 px height without scrolling; `WYSŁANE` follows
  and may scroll.
- from 760 px: two columns — left (max ~440 px) signal + quote, right `WYSŁANE` filling the
  rest; the page content is capped at ~1100 px and centred. Nothing stretches into very long
  lines: inputs and buttons take their column's width.
- no horizontal scrolling at any width; touch targets stay ~44 px.

```
‹ Rolki                     Na żywo
──────────────────────────────────────
SYGNAŁ DLA KUBY
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

- Section label `SYGNAŁ DLA KUBY` (11–12 uppercase, secondary text).
- Shown to `SZRON` only. Kuba (`NOXAVA`) is the recipient, so for him the signal block is absent
  and the screen starts with `CYTAT NA STREAM`. (The API still accepts signals from both users.)
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
