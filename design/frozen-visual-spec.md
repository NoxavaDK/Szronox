# Current authority addendum

The [Reel Detail + Language Check batch](frozen-reel-detail-language-spec.md) supersedes pending/undefined statements below for its eight named surfaces. The original consolidated specification is preserved below. No new renderer or agent dispatch is required.

# FROZEN VISUAL SPECIFICATION — CONSOLIDATED IMPLEMENTATION AUTHORITY

This document replaces any previous instruction that depends on an unavailable renderer PNG or screenshot.

Renderer images were used only to adjudicate the design with the product owner.

Implementation authority is now this WRITTEN visual specification plus the frozen behavioural contracts in T00.

Do not require, infer from or wait for renderer PNGs unless I explicitly add one to the repository later.

All visible UI is in POLISH.
Technical implementation, code and documentation remain in ENGLISH.

==================================================
1. GLOBAL SZRONOX VISUAL LANGUAGE
==================================================

Primary environment:
- Android mobile
- 360 px reference width
- must reflow cleanly at 320 px
- desktop is secondary

Visual character:
- compact editorial production tool
- high information density
- not SaaS dashboard
- not Airtable
- not Notion
- not Trello
- not card-heavy

Colours:
- background: #F7F7F5
- surface: #FFFFFF
- primary text: #171717
- secondary text: #636360
- primary cobalt: #315BD8
- dividers: #E4E4E1
- urgent: #B42332
- evergreen: #216B58
- programme: #2E633D
- warning: restrained amber around #8A570C
- success: #2F6B50

Typography:
- Inter/system sans
- screen title approx. 22/28, weight ~650
- Reel title approx. 16/21, weight ~600
- hook approx. 17/24, weight ~600
- script/body approx. 16/23
- metadata approx. 12–13
- section labels approx. 11–12 uppercase where specified

General layout:
- thin separators
- almost no shadows
- no large rounded cards
- radii only small/subtle where actually needed
- no nested cards
- touch targets approximately 44×44 even when visible actions are compact
- colour must never be the only semantic signal
- AI actions should look like productivity tools, not AI hero features
- no AI gradients, glow or oversized sparkle treatment

Compact text actions are strongly preferred over large CTA buttons except where specifically frozen otherwise.

==================================================
2. MAIN REEL LIST
==================================================

Header:
`Rolki` plus current-user avatar.

Below:
horizontal status selector:

`Pomysły 12`
`Do nagrania 5`
`Montaż 3`
`Gotowe`
`Opublikowane`

Selected state:
- cobalt underline
- horizontally scrollable on narrow screens

Optional compact attention strip:
`⚠ 3 wymagają uwagi`

Reel presentation:
- flat compact rows, not cards
- approximate row height 56–64 px where content permits
- thin horizontal separators
- full row is tappable
- no chevrons

Information priority under width pressure:

1. Reel title
2. urgency / elapsed editing time
3. editor
4. verification, where relevant
5. Green programme state
6. meme

Meme metadata disappears before programme metadata when width is insufficient.

Do not repeat Reel status in a row when the list is already filtered by that status.

Urgent:
- thin red rail
- `Pilne`
- maximum two simultaneous urgency signals
- do not add redundant exclamation treatments everywhere

Priority:
- Normalne does not require a permanent badge
- Pilne and Evergreen may be semantically marked

Editor:
- avatar + name where room permits
- avatar may remain without name at narrow width

Required feed-cover state:
- use a compact outline image/landscape pictogram
- neutral/empty state = not ready
- pictogram + check = ready
- do not use permanent `OKŁ` text
- do not force this metadata into every list row/status
- may be surfaced where operationally useful, especially Montaż/Gotowe

Floating add action:
- cobalt `+`
- approx. 48–52 px

==================================================
3. QUICK ADD — NOWY POMYSŁ
==================================================

Header:
`Nowy pomysł`
back arrow

Manual type selector:
`ZDJĘCIE | LINK | TEKST`

Use compact tabs, not cards.

Android Share Target:
- opens the same Quick Add screen
- when content is already detected, do not show the full selector prominently
- show compact detected type such as:
  `LINK`
  `Zmień`

LINK:
- editorial URL field
- thin divider
- no card

IMAGE:
- compact thumbnail around 80×80
- filename/change affordance
- no giant preview

TEXT:
- flat growing text field

Optional actions:
`+ Dodaj tekst`
`+ Hook`

Priority row:

`! Pilne     ● Normalne     ∞ Evergreen`

Do NOT use generic radio circles.

Default:
`Normalne`

Normalne may use a small cobalt marker.
Pilne red.
Evergreen teal.

Bottom actions:

Primary:
`ZAPISZ`

Large/nearly full-width cobalt action is allowed here.

Secondary:
`✦ Opracuj`

Opracuj must be visually secondary to ZAPISZ.
No oversized AI treatment.

Autosave:
- normally invisible or transient:
  `Szkic zapisany`
- exceptional persistent states only:
  `Brak sieci · zapisano lokalnie`
  retry/failure state as needed

No permanent “saved” status line.

==================================================
4. REEL DETAIL
==================================================

Top:
- back
- compact editable Reel title
- overflow action

Below:
compact metadata cluster.

Do not put metadata into separate cards or vertical bordered columns.

Metadata includes as applicable:
- status
- priority
- editor
- programme state
- meme
- feed-cover pictogram
- verification ONLY if current export exists

Do NOT show:
`Nie sprawdzone`
when there is no current export.

Feed cover:
- always available in Reel Detail metadata
- compact image/landscape pictogram
- neutral = not ready
- pictogram + check = ready
- accessible label names `Okładka do feedu`

Main editorial content:
- HOOK/HOOKI
- SCENARIUSZ

These are central content, not form cards.

Compact AI action row:
`Fakty`
`Aa Język`
`✦ Opracuj`

Visible controls approx. 40–44 px high.

Secondary sections are compact full-width rows with chevrons:

`ŹRÓDŁA / WEJŚCIE`
`MATERIAŁY`
`UWAGI DO MONTAŻU`
`PUBLIKACJA`

No permanent `Zapisano`.
Only transient:
`Zapisywanie`
brief `Zapisano`

Offline/conflict states may remain persistent.

==================================================
5. OPRACOWANIE — COMPLETED RESULT
==================================================

Full-height mobile AI workspace belonging to the Reel.

Header:
`Opracowanie`                         `×`

Below:
quiet Reel context:
`Maszyniści zwalniają`

Exact section order:

1. `CO SIĘ WYDARZYŁO`
2. `DO SPRAWDZENIA`
3. `HOOKI`
4. `SCENARIUSZ`
5. `MEM`
6. `OPIS DO PUBLIKACJI`
7. `HASHTAGI`
8. `TYTUŁ ROBOCZY`
9. `PRIORYTET`
10. `PROGRAM ZIELONYCH`

Use flat editorial sections separated with thin lines.
No cards.

CO SIĘ WYDARZYŁO:
- short AI summary
- informational only

DO SPRAWDZENIA:
- compact warning rows
- amber semantic icon
- informational/research output

HOOKI:
- persistent shortlist
- user's hook labelled:
  `TWÓJ HOOK`
- each hook has compact `×`
- action:
  `+ Wygeneruj więcej`
- no `Użyj` action for hooks

SCENARIUSZ:
- readable editorial block
- action:
  `Użyj scenariusza`

MEM:
- small existing-library thumbnail
- meme name
- short reason/relevant fragment
- action:
  `+ Dodaj`
- suggestion must refer to existing meme library item

OPIS DO PUBLIKACJI:
- generated editable draft where allowed by behavioural contract
- action:
  `Edytuj`

HASHTAGI:
- generated editable text block
- action:
  `Edytuj`

TYTUŁ ROBOCZY:
- intentionally less visually prominent than Hook/Script
- action:
  `Edytuj` or frozen implementation equivalent
- do not make this a hero output

PRIORYTET:
- suggested semantic priority
- short reason
- example:
  `Pilne`
  `Protest rozpoczyna się jutro.`
- action:
  `Ustaw Pilne`

PROGRAM ZIELONYCH:
- restrained programme green
- possible connection summary
- action:
  `Sprawdź postulat`

No `Zastosuj wszystko`.

==================================================
6. PUBLIKACJA — EXPANDED REEL DETAIL SECTION
==================================================

This is an expanded inline Reel Detail section, NOT a separate large screen.

It contains:

A. `OKŁADKA DO FEEDU`

Required every Reel.

Show:
- completion state
- optional attached/reference asset where available
- compact actions to add/change/open reference

Completion control must work even without an attached file.

Feed-cover completion is the workflow truth.

B. `OPIS`

Editable publication description.

C. `HASHTAGI`

Editable hashtags text block.

D. Primary copy action:

`Kopiuj opis`

It copies:

description + "\n\n" + hashtags

when both exist.

This means:
- exactly two newline characters
- one blank line between description and hashtags

If only one field has content, copy only that field.

E. `PO PUBLIKACJI`

May contain:
- publication date
- publication links
- `+ Dodaj link`

Keep all of this compact.
Do not create large cards.

==================================================
7. SPRAWDŹ POSTULAT — SEARCH RESULTS
==================================================

Full-height workspace belonging to a Reel.

Header:
`Sprawdź postulat`                     `×`

Below:
quiet Reel context:
`Maszyniści zwalniają`

Maximum 3 candidates.

Candidates are FLAT editorial sections separated by thin lines.

No cards.
No full-width CTA buttons.
No filled status pills/badges.

Each candidate order:

1. match strength
2. programme category
3. proposal title
4. `FRAGMENT PROGRAMU`
5. exact evidence excerpt
6. source row
7. `DLACZEGO PASUJE`
8. short AI explanation
9. `Przypnij`

Match labels:

`MOCNE DOPASOWANIE`
`POŚREDNIE DOPASOWANIE`

Use plain compact uppercase text.

Strong:
- restrained programme green

Indirect:
- quieter neutral/green treatment
- NOT amber warning/error semantics

Category example:
`PRAWA PRACOWNICZE`

Proposal title:
strong readable typography.

Evidence:
label:
`FRAGMENT PROGRAMU`

Excerpt is actual programme evidence.

Source row example:

`Praca i gospodarka · s. 42`          `↗`

Compact, tappable.
No raw URL.

Relevance:
`DLACZEGO PASUJE`

Then AI explanation.

Candidate action:
`Przypnij`

Same casing and same compact editorial text-action styling for every candidate.

Do NOT:
- use `PRZYPNIJ`
- use large blue buttons
- visually make the first candidate's action larger

At bottom:

`Nie ma dobrego dopasowania`

This is a quieter secondary text action than `Przypnij`.

No percentages.
No probability/confidence scores.
No search filters.
No web-source UI.

==================================================
8. ATTACHED PROGRAMME PROPOSITION
==================================================

Opening an already attached proposition reuses the visual grammar of ONE Sprawdź postulat candidate.

Do not rerun search merely by opening it.

Order:

1. match strength near top
2. category
3. proposal/title
4. `FRAGMENT PROGRAMU`
5. exact persisted excerpt
6. source row + open icon
7. `DLACZEGO PASUJE`
8. stored AI explanation

Bottom actions:

`Zmień postulat`

`Odłącz`

Both are compact text actions.

`Odłącz` is visually quieter.

Do NOT use large CTA buttons.

No additional separate design system.

==================================================
9. SPRAWDŹ FAKTY — COMPLETED RESULTS
==================================================

Full-height scrollable workspace.

Header:
`Sprawdź fakty`                        `×`

Below:
quiet Reel context:
`Maszyniści zwalniają`

Summary:
`3 twierdzenia · 2 wymagają uwagi`

No score.
No percentage.
No progress ring.

Each factual claim is a flat editorial section.

Order within every claim:

1. STATUS
2. CLAIM
3. `WYJAŚNIENIE`
4. explanation
5. `ŹRÓDŁA`
6. source rows
7. `PROPONOWANA KOREKTA` if applicable
8. proposed correction
9. `Użyj korekty` if applicable

Status labels:

`POTWIERDZONE`
`NIEPEWNE`
`SPRZECZNE ZE ŹRÓDŁAMI`

IMPORTANT:
These are PLAIN compact uppercase editorial text labels.

Do NOT render them as filled pills/badges.

Semantic text colour:
- POTWIERDZONE → restrained success green
- NIEPEWNE → restrained amber
- SPRZECZNE ZE ŹRÓDŁAMI → restrained red

Colour is supplementary; wording remains the status signal.

CLAIM:
- prominent readable text
- may use quotation marks
- no quotation card/container

WYJAŚNIENIE:
small uppercase editorial label followed by concise explanation.

ŹRÓDŁA:
small uppercase editorial label.

Source row example:

`PAP · 12.09.2026`                     `↗`

Source rows:
- thin dividers where useful
- no cards
- no raw URL
- compact but clearly tappable

Confirmed claim:
- no correction action

Uncertain / contradicted claim may include:

`PROPONOWANA KOREKTA`

then replacement text

then compact text action:

`Użyj korekty`

Do not render `Użyj korekty` as a large button.

At bottom:

`Sprawdź ponownie`

Quiet secondary action.
Clearly tappable but not dominant.

No global “script correct” state.
No AI confidence.
No probability.
No claim checkboxes.

==================================================
10. CURRENTLY NOT VISUALLY FROZEN
==================================================

Do NOT invent final visual UI for surfaces not yet frozen.

In particular, final visual treatment remains pending for:

- `Sprawdź język`
- any future unfinished AI-result surface not explicitly specified above
- any collision UI for Opracuj publication drafts when user content already exists
- anything else explicitly marked pending in T00

T16/UI implementation for those unfinished surfaces remains blocked.

==================================================
11. IMPLEMENTATION AUTHORITY RULE
==================================================

If an older T00/task note says:

- “use the first render”
- “use approved PNG”
- “visual reference supplied separately”

and no such asset exists in the repository:

DO NOT infer design from a missing image.

Use this consolidated written specification instead.

If this specification conflicts with an older screenshot-reference sentence, THIS SPECIFICATION WINS.

Do not dispatch additional UI implementation merely because this specification is now frozen. Normal explicit task/model approval rules still apply.