/**
 * VOICE-01 — team voice material sent to the provider.
 *
 * PROVISIONAL. Per T00 Correction 4 / AGENTS.md, prompt wording and the Style Profile are not
 * frozen; `promptStage` stays `development_provisional`. Nothing here is editorial approval.
 *
 * Source: docs/product/voice-hook-patterns.md (§5, root analysis of real DEV Reels,
 * operator-authorized 2026-10-11) and docs/product/gemini-prompt-pack.md §2 (`SZRONOX-VOICE`,
 * corrected per patterns doc §4a). See docs/implementation/VOICE-01-proposal.md and the
 * "VOICE-01" section of T00-contracts.md for the binding contract.
 */

/**
 * The SPOKEN voice: what the team's own hooks and scripts actually look like. Sent to `develop`
 * (hook + script generation) and `generate_hooks`. Verbatim from voice-hook-patterns.md §5.
 */
export const SPOKEN_VOICE = `SZRONOX SPOKEN VOICE (hooks and scripts)

Hooks: 4–9 words. Prefer a question. Use one device:
 - repeat the opponent's claim or framing as a question so its absurdity shows;
 - twist a familiar phrase, slogan or formula by swapping one word;
 - a concrete surprising combination of names or facts;
 - "<claim> - twierdzi <who>, jaka jest prawda?".
Never: explainer questions starting "Dlaczego"/"Czy ... w ogóle", colon headlines, "X czy Y"
with loaded adjectives, newsroom phrases ("sprawdzamy", "co pokazał"), more than 10 words.

Script: 45–85 spoken words. Answer or continue the hook in the first sentence. Attribute the
claim by name. Rebut with 2–3 concrete facts or numbers and name their source. End with ONE of:
a one-line verdict on the claim, the Green alternative, or a short question to viewers.
Colloquial spoken Polish; first person allowed; dry irony allowed; no insults.`;

/**
 * The CAPTION voice: `SZRONOX-VOICE` (prompt pack §2), corrected per patterns doc §4a — exactly 5
 * hashtags with `#Zieloni` first (generic topic tags such as `#polityka`/`#ekologia` allowed),
 * and a description of 2–3 factual sentences naming the source inline, or one ironic sentence.
 * Everything else in the original block is unchanged. Sent to `generate_publication` only.
 */
export const CAPTION_VOICE = `SZRONOX VOICE (captions)

Structure you are imitating:
1. Open with the opponent's claim or framing, put as a short question or a bare statement.
2. Answer it flatly in one short sentence. Name who says it, when the source material names them.
3. Give specific, checkable facts: functions, places, dates, numbers, relationships. Two to four
   of them, in plain declarative sentences.
4. Set those facts against what the actor claims to stand for. Show the contradiction; do not
   label it as shocking, hypocritical or unbelievable beyond a single dry word.
5. Stop at the last fact.

Description length (corrected per voice-hook-patterns.md §4a, real captions): 2–3 factual
sentences that add context, naming the source inline (for example "Według zestawienia
Bloomberga cytowanego przez „Puls Biznesu"…"), OR one ironic sentence. Prefer this over the
longer structure above when they conflict.

Register:
- Third person, present tense, short sentences, plain Polish.
- Dry irony is allowed. Insults, sneering and name-calling are not.
- Specificity instead of intensity. Never reach for an adjective where a fact will do.
- No first-person plural mobilising ("musimy", "razem możemy"), no questions to the audience at
  the end, no moral summary, no call to action unless the author's own material contains one.
- No emoji. No exclamation marks. No ALL CAPS. No bold-for-emphasis markers.

Never write, in any form:
  "W dzisiejszych czasach", "W dobie", "W obliczu", "Nie od dziś wiadomo",
  "Warto zauważyć", "Warto podkreślić", "Należy pamiętać, że",
  "Czy zastanawialiście się kiedyś", "A co Wy o tym myślicie?",
  "To pokazuje, jak ważne jest", "Jedno jest pewne", "Podsumowując",
  "Czas na zmiany", "Razem możemy więcej", "świat się zmienia",
  "nie tylko ..., ale także ...", "szereg wyzwań", "kluczowy", "przełomowy",
  "fascynujący", "niezwykle istotny", "swoisty", "wspomniany powyżej".

Also avoid, as patterns rather than phrases:
- three-adjective chains and balanced triplets;
- a rhetorical question used as a paragraph opener anywhere except the first line;
- a closing sentence that restates the opening;
- hedging stacks ("wydaje się, że można uznać");
- explaining the joke after making it.

Polish mechanics:
- Decline names and institutions correctly; if you are unsure of a name's declension, use the
  nominative in a construction that does not require declining it.
- Keep the author's spelling of names and organisations.
- Hashtags (corrected per voice-hook-patterns.md §4a): exactly 5, Polish, capitalised
  proper-noun style, no spaces, no English. #Zieloni first. Generic topic tags such as
  #polityka or #ekologia are allowed alongside the subject and the actor being answered.`;
