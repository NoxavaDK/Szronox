# OCT-2026 VISUAL DELTA — Źródło, ideas in the planner, kDrive layout, streams

Status: **DRAFT, revised after Astra review (2026-10-01).** §A–C ready for operator approval; §D in design preparation (D9 approved 2026-10-01). Sections §G SOURCE-02 and §H MEME-VIDEO-01 were operator-approved for implementation on 2026-10-02 and are linked from the authority addendum in `frozen-visual-spec.md`. Other sections retain their existing approval status. Behaviour is in
`docs/implementation/OCT-2026-plan.md`.

Everything in `frozen-visual-spec.md` §1 applies unchanged: Polish UI, 360 px reference and clean
reflow at 320 px, flat rows with thin separators, no cards, compact text actions, colour never the
only signal, touch targets about 44×44. This delta adds surfaces and doesn't restyle any existing
ones.

==================================================
A. PUBLIKACJA — ŹRÓDŁO (SOURCE-01)
==================================================

New block between `OPIS` and `HASHTAGI`. Updated order inside PUBLIKACJA:

1. `OKŁADKA DO FEEDU`
2. plan row (unchanged)
3. `Wygeneruj opis` (unchanged)
4. `OPIS`
5. `ŹRÓDŁO` ← new
6. `HASHTAGI`
7. `Kopiuj opis`
8. `PO PUBLIKACJI`

Field:
- label `Źródło`, same label style as `Opis` / `Hashtagi`;
- flat growing text field, body text style, same as Hashtagi;
- the field always shows the **effective text**, never a greyed placeholder pretending to be text:
  - automatic value present → the value as real text, e.g. `Źródło: Jan Kowalski, OKO.press, 12.09.2026`;
  - user-edited value → that text.

One quiet metadata line under the field (12–13 px, secondary text `#636360`), followed by at most
one compact text action:

| State | Line | Action |
| --- | --- | --- |
| automatic, found (author and/or site/date from page metadata) | `Automatycznie z linku` | `Odśwież` |
| automatic, partial (only the domain, e.g. `Źródło: instagram.com`) | `Automatycznie z adresu strony` | `Odśwież` |
| automatic, pending (domain shown meanwhile) | `Pobieranie danych źródła…` | — |
| automatic, pending past the client's check window (see below) | `Pobieranie trwa dłużej niż zwykle.` | `Sprawdź` |
| automatic, fetch failed (domain shown) | `Nie udało się pobrać danych źródła.` | `Ponów` |
| automatic, site refuses (SOURCE-01a; domain shown) | `Strona blokuje automatyczne pobieranie. Wpisz autora ręcznie.` | — |
| automatic, link not readable (SOURCE-01a; domain shown) | `Tego linku nie da się odczytać automatycznie. Wpisz źródło ręcznie.` | — |
| no link in the capture (field empty) | `Brak linku w materiale.` | — |
| no data yet (Reel created before SOURCE-01, field empty) | `Pobierz dane źródła z linku.` | `Pobierz` |
| edited by user | `Wpisane ręcznie` | `Przywróć automatyczne` (only when an automatic value exists) |
| just restored (see Undo) | `Przywrócono automatyczne źródło.` | `Cofnij` |

Wrapping (320–360 px):
- the line may wrap; the action never shares a line with wrapped text;
- when line + action don't fit on one line, the action goes on its own line directly below, start-aligned;
- the action keeps a 44 px high touch target (the visible text can stay compact) and the same
  secondary-text contrast rules as other compact text actions.

Checking a pending fetch:
- While PUBLIKACJA is expanded and the state is `pending`, the client re-checks every 5 s until the
  state leaves `pending`, up to 4 minutes (this covers the server's whole retry lifecycle). After
  that it shows the "longer than usual" row; `Sprawdź` re-reads once and restarts the window.
- A check, `Odśwież`, `Pobierz` or `Ponów` updates **only** the metadata line and the automatic
  value. It never replaces text the user is typing or has typed but not yet saved.
- If the user is editing the field when an automatic value arrives, their text stays and becomes
  the manual value.

Undo for `Przywróć automatyczne`:
- immediate, no dialog;
- the field immediately shows the automatic value, and `Kopiuj opis` copies it; the previous manual
  text is held only for `Cofnij` (never displayed or copied), and the state line shows
  `Przywrócono automatyczne źródło.` + `Cofnij` until the user edits the field, leaves the Reel,
  or 30 s pass;
- `Cofnij` writes the previous manual text back (an ordinary field save).

Text actions only. No icons, no chips, no AI sparkle: this is deterministic metadata, not AI. The
pending state has no spinner larger than text size.

Kopiuj opis (amends the frozen copy rule, nothing else about it changes):
- uses the **current editable values, including unsaved edits**, of Opis, Źródło (its effective
  text as displayed) and Hashtagi; nothing is saved or modified;
- a part is empty only when it is the empty string, exactly as today; **no part is trimmed or
  rewritten**;
- the non-empty parts in order description, source, hashtags, joined by exactly two newline
  characters; no leading or trailing blank lines are added;
- clipboard success/failure/unavailable feedback and the manual fallback are unchanged and show
  the same composed text.

Collapsed PUBLIKACJA summary (when present): unchanged. The source isn't added to the summary.

==================================================
B. PLAN — IDEAS IN NIEZAPLANOWANE (IDEAS-PLAN)
==================================================

NIEZAPLANOWANE group:
- first: non-idea Reels, exactly as today;
- then a thin divider and a quiet sub-label `POMYSŁY · 4` (11–12 px uppercase, secondary text, count);
- then idea cards, same card component as today, showing the existing status label `Pomysł`.
- No sub-label or divider when there are no unplanned ideas.
- When there are no non-idea items but there are ideas, the group shows the `POMYSŁY` sub-label directly.
- Directly under the `POMYSŁY` sub-label, one quiet hint line (12–13 px, secondary), shown on every
  layout (drag users read it before dropping):
  `Zaplanowanie zmieni status na „Do nagrania”.`
- The empty-group label applies only when both parts are empty.

Scheduling an idea (promotion happens only when an idea gets a date **for the first time** — its
date goes from none to a day; an idea that already has a date and is moved or re-slotted keeps
status `Pomysł`, and none of the copy below appears):
- `Zaplanuj publikację` sheet opened for an unplanned idea shows one quiet line (12–13 px, secondary) directly
  above the bottom actions:
  `Po zaplanowaniu pomysł trafi do „Do nagrania”.`
- After a successful plan (sheet, list `Zaplanuj`, Detail, or desktop drag onto a day), a transient
  confirmation in the existing transient-message style:
  `Przeniesiono do „Do nagrania”`
- No dialog, no confirmation step.
- Unscheduling shows nothing extra.

The planner day card of a promoted idea is an ordinary `Do nagrania` card.

==================================================
C. MATERIAŁY — FOLDER kDrive LAYOUT LINE (KDRIVE-03)
==================================================

Inside the existing `FOLDER kDrive` block, existing state:

- folder name + open affordance (unchanged);
- new quiet location line under it (12–13 px, secondary): `Rolki / 2026-10` or `Rolki / Bez terminu`
  (`Streamy / …` for streams). Omitted for a folder outside the SzroNox layout.

The location line always shows the **last confirmed** location. Move states add a second quiet line
under it:
- moving: `Przenoszenie do Rolki / 2026-11…`
- failed after retries: `Nie przeniesiono do Rolki / 2026-11.` + compact text action `Ponów`
  (warning amber text colour plus the wording; colour isn't the only signal). The first line still
  reads e.g. `Rolki / 2026-10`, where the folder actually is.

Nothing else in MATERIAŁY changes. A move never blocks `Otwórz kDrive`, uploads or export actions.

==================================================
D. STREAMS (STREAM-01)
==================================================

D1. Stream marker
- Outline "broadcast" pictogram (16 px, stroke matches the feed-cover pictogram style, secondary
  text colour), placed before the title in list rows, planner cards and the Reel Detail title row.
- Always paired with the word `Stream` (metadata text style) in list rows, planner cards and the
  Detail metadata cluster. At the narrowest widths the word stays and other metadata yields first
  (it ranks directly after the title in the §2 priority list). Accessible name `Stream`.
- Rolki get no marker (the default format is unmarked).

D2. Quick Add
- A compact format selector above the `ZDJĘCIE | LINK | TEKST` selector: `ROLKA | STREAM`, same
  compact tab style, default `ROLKA`.
- Selecting `STREAM`:
  - header becomes `Nowy stream`;
  - an extra field `Tytuł streamu` (required) above the type selector;
  - the capture becomes optional (a stream may start with only a title);
  - `✦ Opracuj` and `+ Hook` are not shown; `ZAPISZ` is the only bottom action.
- Android Share Target always opens as `ROLKA`; the selector stays available.

D3. Stream Detail
Same structure as Reel Detail, with these differences:
- Main editorial content: `TEMATY` replaces `HOOK/HOOKI` and `SCENARIUSZ`.
- **No AI entry point anywhere on a stream in STREAM-01.** Not shown:
  - the AI action row (`Fakty`, `Aa Język`, `✦ Opracuj`);
  - any contextual or primary action that starts AI (e.g. an `Opracuj` primary action for a new item);
  - `Wygeneruj opis` / `Wygeneruj nowy opis` in PUBLIKACJA;
  - hook suggestions and the programme (`Program Zielonych` / `Sprawdź postulat`) metadata and actions;
  - list/long-press quick actions that start AI.
  PUBLIKACJA is manual: Opis and Hashtagi are typed, and ŹRÓDŁA come from topics (D7).
  The API refuses every AI action on a stream (`422 VALIDATION_ERROR`, `reason: not_available_for_stream`).
  Manual meme assignment stays available.
- Secondary rows unchanged: `ŹRÓDŁA / WEJŚCIE` (the stream's own capture, if any), `MATERIAŁY`,
  `UWAGI DO MONTAŻU`, `PUBLIKACJA`.

D4. TEMATY
- Section label `TEMATY · 3`.
- Flat numbered rows, thin separators, no cards. Collapsed row:
  - `1.` + topic title (Reel title style 16/21, ~600);
  - one metadata line (12–13 px, secondary): kind, then the topic's source line when present:
    - absorbed: `Temat streamu · OKO.press, 12.09.2026`
    - reference: `Odwołanie · Do nagrania · OKO.press, 12.09.2026`
  - overflow `⋯` (44×44 target) with: `W górę`, `W dół`, and `Odłącz` (absorbed) or
    `Usuń odwołanie` (reference).
- Tapping a row expands it inline. Only one topic is expanded at a time.
  - Absorbed topic: editable `Tytuł` (single line), `NOTATKI` and `SCENARIUSZ` (flat growing
    fields), `Źródło` with the same behaviour as §A, and the original capture as a quiet
    `Materiał źródłowy` row that opens it read-only.
    - Edits autosave like Reel Detail fields (debounced, transient `Zapisywanie` / brief `Zapisano`,
      the existing offline/conflict states).
  - Reference topic: read-only status, editor and source line, plus a compact `Otwórz rolkę` text
    action. Nothing of the referenced Reel is editable here.
- Switching away from an expanded absorbed topic (expanding another topic, collapsing it,
  `Otwórz rolkę`, or leaving the stream) first flushes its pending save.
  - If that save succeeds (or there was none), the switch happens.
  - If it fails or conflicts, the switch does **not** happen. The topic stays expanded with the
    existing error/conflict state, offering `Ponów` or `Odrzuć zmiany`. Unsaved text is never
    silently dropped.
- Desktop: a drag handle at the row start may reorder topics. Mobile reorders only through
  `W górę` / `W dół`.
- Below the list, compact text actions: `+ Dodaj temat` (D5) and `+ Nowy temat`.
- `+ Nowy temat` opens an inline form at the end of the list (not a sheet), with the first field focused:
  - `Tytuł tematu` (required);
  - `Link` (optional, URL; when present it feeds the topic's automatic Źródło as in §A);
  - `Notatka` (optional);
  - actions `Dodaj` (cobalt text action, disabled until the title is non-empty) and `Anuluj`.
  Nothing is created before `Dodaj`. `Anuluj` with typed text discards it without a dialog.
  A failed `Dodaj` keeps the form and its text, with `Nie udało się dodać tematu.` + `Ponów`. On
  success the new topic appears expanded.
- Empty: `Brak tematów.` + the same two actions.
- `Odłącz`: no dialog; transient `Pomysł wrócił do listy`.

D5. Dodaj temat (picker)
- Full-height sheet, header `Dodaj temat` + `×`, a search field under the header.
- Flat rows grouped: `ROLKI` first (Do nagrania, Montaż, Gotowe, Opublikowane), then `POMYSŁY`.
  The grouping and sub-label style match §B.
- Row: title + status label + plan label when planned.
- Tapping a Rolka (Do nagrania or later) adds it as a reference and closes the sheet.
- Tapping an idea expands that row inline with two choices, each a compact action followed by its
  consequence as a quiet line:
  - `Przenieś do streamu` (cobalt, the default; absorbed) — `Pomysł zniknie z listy. Możesz go później odłączyć.`
  - `Dodaj odwołanie` (secondary) — `Pomysł pozostanie na liście.`
- Rows already in this stream are disabled with `W tym streamie`. Streams and ideas absorbed
  elsewhere aren't listed.

D6. Linked Rolka Detail
A quiet row in the metadata cluster of a referenced Reel: broadcast pictogram + `W streamie: <tytuł streamu>`. Tapping
it opens the stream. With more than one stream: `W 2 streamach`, which opens a short list.

D7. Stream PUBLIKACJA
- `ŹRÓDŁO` (§A) becomes `ŹRÓDŁA`: a read-only list of one line per topic, in topic order,
  duplicates removed. Each line is edited on its topic (absorbed) or its Rolka (linked). Quiet line:
  `Źródła z tematów`.
- Kopiuj opis: description, then the source lines joined by **one** newline, then hashtags. The
  sections are separated by two newlines, and empty sections are skipped.

D8. Planner
Streams appear and schedule exactly like Rolki, with the D1 marker. No other change.

D9. Deleting and restoring (operator-approved 2026-10-01)
- Absorbed topics belong to their stream and share its lifecycle. Deleting a stream soft-deletes it
  together with its absorbed ideas; restoring it from `Usunięte` restores them, in place, in the
  same order. Referenced Reels are never affected.
- Confirmation (existing delete dialog, existing `Anuluj` / `Usuń` labels), body when the stream
  has absorbed topics:
  `Usunąć stream „<tytuł>”? Razem z nim zostaną usunięte 2 tematy przeniesione z pomysłów. Możesz je przywrócić razem ze streamem z „Usunięte”.`
  With none, the existing Reel wording applies.
- `Usunięte` lists the stream once (with the D1 marker), never its absorbed ideas separately.
- To keep an absorbed idea, `Odłącz` it before deleting the stream.
- An absorbed idea has no own delete action; `Odłącz` it first.
- A referenced Reel that is deleted stays in TEMATY as a muted row `Usunięta rolka · <tytuł>`, with
  only `Usuń odwołanie`. Restoring that Reel brings the row back to normal.

==================================================
F. REEL DETAIL — + DODAJ HOOK (HOOK-ADD-01, operator-approved 2026-10-02)
==================================================

- Compact text action `+ Dodaj hook` directly under the HOOKI list (cobalt text action, 44 px
  target). It's always available while the Reel is editable, including when a hook is already
  selected and the others sit under `Pozostałe hooki (n)`, and when there are no hooks yet.
- It opens the existing inline hook editor, empty and focused, as the last row, with
  `Anuluj` / `Gotowe`. Enter saves; Escape cancels. The action is hidden while the editor is open.
- `Gotowe` appends a `własny` hook at the end of the list through the existing add-hook mutation.
  It is **never selected automatically** (selection stays an explicit tap).
- Failure keeps the text in the editor with the truthful error line (same style as editing a hook).
  A non-empty draft counts as unsaved work.
- Hidden when the Detail is read-only (deleted Reel), exactly like `Edytuj` / `×`.

==================================================
G. ŹRÓDŁA / WEJŚCIE — LINK DO ARTYKUŁU (SOURCE-02, operator-requested 2026-10-02)
==================================================

Only for a Reel whose capture has **no link** (only an image and/or text without a URL). The
original capture stays exactly as captured and is never edited.

Inside the expanded `ŹRÓDŁA / WEJŚCIE` section, after the original capture and before the
editing note:
- label `Link do artykułu` (same label style as the section's other labels);
- empty: compact text action `+ Dodaj link do artykułu`;
- adding/changing: an inline single-line URL field (placeholder `https://…`), then
  `Anuluj` / `Zapisz`. `Zapisz` is disabled until the text is a full `http(s)://` link; an invalid
  value shows `Wklej pełny link (https://…).` under the field. Enter saves; Escape cancels;
- saved: the link as one truncated line (host + path, ellipsis, full URL in the accessible name),
  then compact text actions `Otwórz` (new tab), `Zmień`, `Usuń`;
- `Usuń`: immediate, no dialog; transient `Usunięto link.` with `Cofnij` (30 s or the next edit),
  the same pattern as §A undo;
- a failed save keeps the typed link with the existing truthful error style.

Effects:
- PUBLIKACJA `Źródło` treats the added link exactly like a captured one (§A states, automatic
  fetch). In §A the `Brak linku w materiale.` row gains the compact action `Dodaj link`, which opens
  `ŹRÓDŁA / WEJŚCIE` with the URL field focused.
- AI actions that read the captured link today read the added link the same way.
- A Reel whose capture already has a link shows no `Link do artykułu` row.

==================================================
H. MEMES — VIDEO MEMES (MEME-VIDEO-01, operator-requested 2026-10-02)
==================================================

Meme form (`MemePicker`, `+ NOWY MEM`):
- the file chooser accepts images (JPG, PNG, WebP, GIF) and **any video format**;
- size limit 25 MB for videos (8 MB for images, unchanged). Over the limit:
  `Wideo przekracza limit 25 MB.` before anything is uploaded;
- a chosen video shows its first frame as the 80×80 preview (the same slot as an image preview),
  with a small ▶ pictogram in its corner. If the browser can't decode that format, the preview is
  a neutral video pictogram plus the file name. Saving is allowed either way;
- progress and error states are unchanged (`Wysyłanie…`, truthful Polish errors, the form keeps
  name and file on failure).

Picker rows (search results and attached list):
- a video meme shows its poster thumbnail (or the neutral video pictogram) with the ▶ pictogram.
  The accessible name includes `wideo`;
- tapping the **thumbnail** plays the clip inline in the thumbnail slot: **muted, looped,
  playsinline**, no controls, no sound toggle. Tapping it again stops it. Tapping the row text keeps
  today's behaviour (select/attach);
- only one clip plays at a time; leaving the picker stops it.

Reel Detail metadata: `Mem: <name>` gains a small ▶ pictogram for a video meme. Nothing else changes.

AI: `Opracuj` may suggest a video meme exactly like an image meme (name/description). The AI
workspace's `MEM` row shows the poster (or pictogram) with ▶.

Multiple memes per Reel are unchanged: the existing `+ kolejny mem` attaches more, and the first is
the primary.

==================================================
E. NOT IN THIS DELTA
==================================================

AI per topic (STREAM-02), a long-video format distinct from Stream, per-topic exports, kDrive
browsing, a folder picker.
