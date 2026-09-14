# FROZEN SPEC BATCH UPDATE — REEL DETAIL + LANGUAGE CHECK

Please incorporate the following newly frozen product/visual decisions into the authoritative T00/specification.

These are DELTAS to the frozen baseline and the consolidated written visual specification already supplied.

Do NOT restate or reopen already frozen specifications for:
- global SzroNox visual language;
- Main Reel List;
- Quick Add;
- base Reel Detail;
- Opracowanie;
- Publikacja/feed cover/copy behaviour;
- Sprawdź postulat;
- attached programme proposition;
- Sprawdź fakty.

This batch adds/finalizes only:

1. Sprawdź język
2. Materiały
3. Reel Detail metadata selectors
4. Meme picker/shared library interaction
5. Źródła / Wejście
6. Uwagi do montażu
7. Reel overflow/delete
8. Deleted Reels access

Where an older specification says one of these surfaces is still visually pending, this batch supersedes that statement.

Do not dispatch new implementation work merely because these specifications are now frozen. Existing explicit task/model approval rules remain in force.

==================================================
1. SPRAWDŹ JĘZYK
==================================================

`Sprawdź język` is now visually and behaviorally frozen.

It is a full-height scrollable Reel workspace using the existing compact editorial SzroNox visual language.

ORDER

1. Header:
   `Sprawdź język` + close action

2. Quiet Reel context

3. `DO POPRAWY`
   - short diagnostic observations
   - no score
   - no percentage
   - no per-observation fix buttons

4. `WERSJA A`
   - quiet context: `Twój tekst`
   - editable snapshot of the original script
   - compact action: `Użyj wersji A`

5. thin separator

6. `WERSJA B`
   - quiet context: `Propozycja po korekcie`
   - editable AI rewrite
   - compact action: `Użyj wersji B`

7. bottom secondary action:
   `Sprawdź ponownie`

IMPORTANT

Do NOT use A/B tabs.

Both versions are visible simultaneously and vertically:
- A first
- B below

Both are directly editable.

Preserve the flat editorial writing treatment.
Do not turn either version into a heavy bordered textarea/card.

Normal platform text selection, copying and pasting must work so the user may manually construct a hybrid by moving fragments between A and B.

Editing A or B does NOT modify the Reel.

`Użyj wersji A` / `Użyj wersji B` replaces the WHOLE current Reel script with the CURRENT EDITED CONTENTS of that version.

Do not add:
- merge button;
- diff UI;
- track changes;
- third save action.

If the authoritative Reel script has changed since the language-check snapshot, applying A or B must not blindly overwrite it.

Treat the result as stale and require a new check.

No additional render is required.

==================================================
2. MATERIAŁY
==================================================

`MATERIAŁY` is an EXPANDED INLINE SECTION of the existing Reel Detail.

It is NOT a separate screen.

A renderer experiment introduced unrelated surrounding Reel Detail concepts that are NOT approved.

Do NOT infer or add:
- `Szczegóły / Opracowanie / Postulat / Notatki` top tabs;
- large Reel hero/thumbnail architecture;
- `WERSJA ROBOCZA` badge;
- alternative top-level Reel Detail architecture;
- `MEM / MONTAŻ / HISTORIA` sections merely because they appeared in that mockup.

Only the internal `MATERIAŁY` structure below is frozen.

STRUCTURE

Collapsed:
`MATERIAŁY` + chevron

Expanded, exact order:

1. `FOLDER kDrive`
2. `AKTUALNY EKSPORT`
3. `WERYFIKACJA` only when a current export exists

Use:
- flat editorial layout;
- thin separators;
- compact actions;
- no cards;
- no large CTA buttons.

------------------------------
FOLDER kDrive
------------------------------

Initial state:

`FOLDER kDrive`

`Brak folderu`

`+ Utwórz folder kDrive`

Folder creation is always an explicit user action.

Do not create a kDrive folder automatically:
- during capture;
- when changing status;
- when entering production.

Existing state:

`FOLDER kDrive`

folder name/reference + open/external affordance

`Otwórz kDrive`

If the folder has been moved, deleted or is inaccessible:
- preserve the stored reference;
- expose an explicit unavailable state;
- permit relinking;
- never silently create a replacement folder.

------------------------------
AKTUALNY EKSPORT
------------------------------

No export:

`AKTUALNY EKSPORT`

`Brak`

Do not show any verification state.

Existing export:

`AKTUALNY EKSPORT`

current filename/reference + open affordance

`Zmień eksport`

This is NOT a large-file uploader.

Selecting/changing the current export means identifying an existing production file/reference.

Every explicit replacement creates a new application-owned export revision, including choosing the same underlying file/reference again.

------------------------------
WERYFIKACJA
------------------------------

Render this section ONLY when a current export exists.

Verification belongs to the exact current export revision.

Verification remains recommended and does NOT gate:
- `Gotowe`;
- `Opublikowane`.

If no valid editor is selected:

`Wybierz montażystę, aby wskazać osobę sprawdzającą.`

No verification action is available.

Export linking/replacement remains allowed.

If current user is the editor:

The editor cannot verify their own export.

Show a quiet derived state, e.g.:

`○ Czeka na Szron`

using the actual peer identity.

If current user is the expected verifier and the current export has not been verified:

`○ Nie sprawdzone`

Action:

`Oznacz jako sprawdzony`

This verifies only the current export revision.

Verified state:

`✓ Szron`

using the actual verifier identity.

A quiet verification timestamp may be shown but is not required in MVP.

If the export changes after verification:

`◷ Nieaktualne`

Use restrained warning styling.

Explanation:

`Poprzedni eksport sprawdził Szron.`

For the current expected verifier expose:

`Oznacz nowy eksport jako sprawdzony`

After successful verification of the new revision, return to the current verified state.

DO NOT PLACE IN MATERIAŁY

Do not put here:
- feed cover;
- publication description;
- hashtags;
- original captured source/input;
- Meme-library management;
- arbitrary production-file browsing.

Feed cover remains in `PUBLIKACJA`.

`MATERIAŁY` is specifically:

kDrive folder → current export → verification.

No additional render is required.

==================================================
3. REEL DETAIL METADATA SELECTORS
==================================================

Three Reel Detail metadata properties are directly editable:

1. STATUS
2. PRIORYTET
3. MONTAŻYSTA

They remain compact metadata controls.

On mobile, tapping a value opens a compact bottom sheet.

Do NOT:
- navigate to a separate screen;
- use desktop-style dropdown UI on mobile;
- require an additional Save action.

One explicit selection applies the mutation.

------------------------------
STATUS
------------------------------

Bottom-sheet heading:

`STATUS`

Exactly these values:

`Pomysł`
`Do nagrania`
`Montaż`
`Gotowe`
`Opublikowane`

Show the current value with a compact selected-state indicator.

Selection:
- uses normal version-checked mutation;
- closes after successful mutation;
- refreshes from authoritative server state.

Entering `Montaż` from another status starts the current editing/waiting period.

Saving/reselecting `Montaż` while already in it does not reset the timer.

Leaving and subsequently re-entering `Montaż` starts a new period.

Selecting `Opublikowane` while `feedCoverDone === false` must fail without partial state change and use the already frozen Polish validation:

`Przed zmianą statusu na „Opublikowane” oznacz „Okładka do feedu” jako ukończoną.`

Verification remains irrelevant to the ability to choose `Gotowe` or `Opublikowane`.

------------------------------
PRIORYTET
------------------------------

Heading:

`PRIORYTET`

Exactly:

`! Pilne`
`● Normalne`
`∞ Evergreen`

Preserve existing Quick Add semantics:
- Pilne → urgent red
- Normalne → cobalt/neutral
- Evergreen → teal

Do not use generic radio-circle styling.

Changing priority while in `Montaż` does NOT reset the editing timer.

Attention thresholds remain:

- Pilne: 24 h
- Normalne: 96 h
- Evergreen: 168 h

A priority change simply changes the threshold applied to the existing editing period.

------------------------------
MONTAŻYSTA
------------------------------

Visible Polish label:

`MONTUJE`

Heading:

`MONTUJE`

Options:

`NOXAVA`
`SZRON`

with their existing small avatars.

Also allow a quieter final option:

`Brak`

Editor may legitimately be null.

Changing editor while in `Montaż` does NOT reset the editing timer.

There is NO verifier selector.

Verifier derives automatically:

- editor NOXAVA → verifier SZRON
- editor SZRON → verifier NOXAVA
- editor null → verifier undefined

Never infer the editor from the acting user.

No editor prevents verification but does not prevent export linking/replacement.

------------------------------
MOBILE / DESKTOP
------------------------------

Mobile:
compact bottom sheet.

Each option has an approximately 44 px touch target.

Dismissal without selection makes no change.

Mutation failure/conflict:
- preserve authoritative value;
- do not show false success;
- use existing Polish conflict/error behavior.

Desktop may use a compact equivalent popover/select interaction.

Available values and semantics are identical.

No additional render is required.

==================================================
4. MEME PICKER / SHARED LIBRARY
==================================================

There is one shared Meme library for NOXAVA and SZRON.

Meme records are independent of Reel/Meme assignments.

Detaching a Meme from a Reel NEVER deletes the shared Meme record.

------------------------------
PICKER
------------------------------

Can be opened from:
- Reel Detail;
- Opracowanie Meme suggestion.

Visible structure:

`MEM`

`Szukaj memu...`

Then compact rows:
- small thumbnail;
- Meme name.

Bottom action:

`+ NOWY MEM`

No cards.

Do not add in MVP:
- categories;
- folders;
- analytics;
- usage counts;
- semantic AI Meme search.

Search existing Meme library metadata/name only.

------------------------------
ATTACHING
------------------------------

Tapping an existing Meme:
- attaches it to the current Reel;
- closes the picker.

If there are currently no attached Memes, the first becomes primary by order.

Normal UX is 0 or 1 Meme, while the architecture/UI may support several.

In Reel Detail an attached Meme may show:
- thumbnail;
- name;
- compact remove `×`.

When a Meme is attached provide:

`+ kolejny`

to add another.

No drag-and-drop ordering in MVP.

First Meme is primary by order.

Removing `×` only removes the Reel/Meme relationship.

------------------------------
OPRACUJ
------------------------------

Opracuj suggests at most ONE existing Meme using a valid `memeId`.

Never:
- invent a Meme;
- silently replace an attached Meme.

`+ Dodaj` uses the normal attachment mutation.

------------------------------
+ NOWY MEM
------------------------------

Minimal creation:

`NOWY MEM`

Required:

`Nazwa`

image/thumbnail file

Action:

`Zapisz`

Do not add:
- categories;
- tags;
- folders;
- analytics;
- permissions;
- semantic indexing.

When opened from a Reel Meme picker:

successful creation:
1. creates the shared Meme library item;
2. immediately attaches it to the current Reel;
3. returns to the Reel/picker context.

A future standalone library context may create without attachment.

No additional render is required.

==================================================
5. ŹRÓDŁA / WEJŚCIE
==================================================

`ŹRÓDŁA / WEJŚCIE` is an expanded inline Reel Detail section.

PURPOSE

It displays the ORIGINAL captured source material from which the Reel was created.

It must remain separate from:
- script;
- hooks;
- Fact Check evidence;
- later AI research;
- publication content.

The original captured input remains preserved and is not silently rewritten as the Reel develops.

Expanded heading:

`ŹRÓDŁA / WEJŚCIE` + collapse chevron

Only show subsections that actually contain content.

------------------------------
ORYGINALNE WEJŚCIE
------------------------------

For URL:

`LINK`

display the URL or compact readable source reference.

Action:

`Otwórz źródło` + external/open icon.

For shared/captured text:

`TEKST`

show the original captured text.

Original share metadata/title remains preserved according to the existing capture contract.

Do not destructively derive/replace original fields.

------------------------------
DODATKOWY TEKST
------------------------------

If additional text was entered during Quick Add alongside a URL/image, show it separately.

Do not destructively merge it into the source representation.

------------------------------
ZAŁĄCZNIKI
------------------------------

Show supported captured images as compact rows containing:
- small thumbnail;
- filename;
- open/view affordance.

Multiple original images are allowed.

Do not silently omit supported captured images.

Unsupported original descriptors remain preserved according to the capture contract but must not be presented as successfully uploaded assets.

------------------------------
NOTATKA DO WEJŚCIA
------------------------------

Separate editable field:

`NOTATKA DO WEJŚCIA`

For user-added context such as:
- important timestamp;
- focus point;
- why the source matters;
- production context.

This note is mutable.

It is NOT part of immutable `originalInput`.

Editing it must never rewrite `originalInput`.

Use the normal version-checked Reel mutation.

IMPORTANT

External evidence found later through Fact Check does NOT appear here.

Fact Check evidence remains with Fact Check results.

Use flat editorial Reel Detail styling:
- no cards;
- thin separators;
- small thumbnails;
- compact open actions;
- no generic file manager.

No additional render is required.

==================================================
6. UWAGI DO MONTAŻU
==================================================

`UWAGI DO MONTAŻU` is an expanded inline Reel Detail section.

PURPOSE

One shared editable production note for practical editing instructions between NOXAVA and SZRON.

Example:

`Napisy od 0:03.`

`Mem po zdaniu o ministerstwie.`

`Wyciąć pauzę przed końcówką.`

Both users may edit it.

BEHAVIOUR

Use one multiline editable plain-text field.

Preserve:
- line breaks;
- manually typed bullets;
- normal text.

Use existing version-checked Reel mutation/concurrency rules.

Do NOT create:
- comment threads;
- per-user notes;
- assignments;
- structured checklist items;
- AI-generated editing instructions;
- task statuses;
- timestamps per line;
- separate note records.

This is deliberately one simple shared production note.

VISUAL

Expanded:

`UWAGI DO MONTAŻU` + collapse chevron

Use flat Reel Detail editorial treatment.

Do not use:
- card UI;
- chat bubbles;
- comments interface;
- rich-text toolbar.

No additional render is required.

==================================================
7. REEL OVERFLOW / DELETE
==================================================

The Reel Detail `⋮` overflow menu remains deliberately minimal.

For an active Reel it contains ONLY:

`Usuń rolkę`

Do not place in this menu:
- status;
- priority;
- editor;
- AI actions;
- export;
- kDrive;
- Meme assignment;
- duplicate/share actions.

Those have dedicated locations or are outside MVP.

------------------------------
DELETE
------------------------------

`Usuń rolkę` is a soft-delete action.

Confirmation:

`Usunąć rolkę?`

`Rolka zniknie z aktywnych widoków. Będzie można ją później przywrócić.`

Actions:

`Anuluj`
`Usuń`

Successful soft delete removes the Reel from active views.

It must NOT delete:
- shared Meme records;
- kDrive folders/files;
- indexed programme/source data.

Use the existing version-checked soft-delete contract.

Permanent deletion is outside MVP.

No additional render is required.

==================================================
8. DELETED REELS ACCESS
==================================================

Soft-deleted Reels must be recoverable in MVP but recovery remains outside the primary workflow.

Do NOT add `Usunięte` as:
- a sixth Reel status;
- a main status tab;
- a permanent primary-navigation item.

Primary Reel status navigation remains exactly:

`Pomysły`
`Do nagrania`
`Montaż`
`Gotowe`
`Opublikowane`

Expose:

`Usunięte`

as a quiet secondary entry from a non-primary main `Rolki` menu, for example the screen-level overflow/profile menu.

It should be discoverable when needed but absent from the normal production workflow.

------------------------------
USUNIĘTE VIEW
------------------------------

Show a compact list using the existing Reel-list visual language.

Do not invent a new card layout.

Deleted Reels are excluded from all normal status lists.

Opening a deleted Reel provides:

`Przywróć rolkę`

Successful restore returns it to its previously persisted Reel status and restores normal visibility.

OUT OF SCOPE

Do not add:
- permanent deletion;
- retention countdowns;
- bulk trash operations;
- automatic purging;
- separate trash-management architecture.

No additional render is required.

==================================================
BATCH INTEGRATION RULE
==================================================

Please integrate these decisions into the authoritative planning/contracts without reopening previously frozen product decisions.

Where an older note says:
- `Sprawdź język` is visually pending;
- the above Reel Detail subsections are not yet defined;
- an unavailable renderer screenshot is required;

this batch supersedes that statement.

Do not infer additional functionality from old renderer mockups.

Do not dispatch a new feature agent merely because this batch is incorporated.

After incorporating the batch, continue using the existing explicit delegation/approval process for implementation.