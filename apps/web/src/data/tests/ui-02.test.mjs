/**
 * UI-02 acceptance for the web layer: explicit primary-action rules, publication emphasis,
 * readable fallback identity, radial menu layout/actions, planner wording and the semantic
 * colour boundaries. Pure logic is executed; wiring without a DOM renderer is asserted on source.
 * Run: node --experimental-strip-types --test src/data/tests/*.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { detailPrimaryAction, isReadOnlyReel, publicationEmphasis } from '../detail-actions.ts';
import { reelLabel, urlLabel } from '../reel-label.ts';
import { unscheduledEmptyLabel } from '../planner.ts';
import { radialActions, radialLayout, RADIAL_ITEM_SIZE } from '../../ui/radial-menu.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, relative), 'utf8');
const between = (text, start, end) => { const from = text.indexOf(start); assert.ok(from >= 0, start); return text.slice(from, text.indexOf(end, from + start.length) + end.length); };

const base = {
  status: 'idea', script: 'Skrypt.', deletedAt: null, currentExport: null, verificationState: null,
  publicationDescription: '', publicationHashtags: '', feedCoverDone: false,
  hooks: [{ id: 'h1', text: 'Hook', source: 'ai', position: 0 }], selectedHookId: null, editorId: null,
};
const act = (reel, extra = {}) => detailPrimaryAction({ reel: { ...base, ...reel }, aiAvailable: true, canVerify: true, planLabel: null, ...extra });

// ── C. primary action rules ────────────────────────────────────────────────────────────────

test('a deleted Reel exposes Przywróć as the primary action, never Opracuj, and is read-only', () => {
  for (const reel of [{ script: '' }, { status: 'published' }, { status: 'ready' }]) {
    assert.deepEqual(act({ ...reel, deletedAt: '2026-09-27T10:00:00Z' }), { kind: 'restore', label: 'Przywróć rolkę', tone: 'primary' });
  }
  assert.equal(isReadOnlyReel({ deletedAt: '2026-09-27T10:00:00Z' }), true);
  assert.equal(isReadOnlyReel({ deletedAt: null }), false);
});

test('a published Reel gets no hook CTA (or any work CTA)', () => {
  assert.equal(act({ status: 'published' }), null);
  assert.equal(act({ status: 'published', script: '' }), null, 'no Opracuj after publication either');
  assert.equal(act({ status: 'published' }, { planLabel: 'Jutro, Rano' }), null);
});

test('missing prerequisites expose the relevant next action, in phase order', () => {
  assert.equal(act({ script: '' }).kind, 'develop');
  assert.equal(act({ script: '' }, { aiAvailable: false }).kind, 'write_script', 'no generic AI action when AI is unavailable');
  assert.equal(act({ status: 'editing' }).kind, 'add_export');
  assert.deepEqual(act({ status: 'editing', currentExport: { revision: 2 }, verificationState: 'outdated', editorId: 'u2' }),
    { kind: 'reverify_export', label: 'Eksport zmieniony · Sprawdź ponownie', tone: 'attention' });
  assert.notEqual(act({ status: 'editing', currentExport: { revision: 2 }, verificationState: 'outdated', editorId: 'u2' }, { canVerify: false })?.kind, 'reverify_export');
  assert.equal(act({ status: 'ready' }).kind, 'generate_publication');
  assert.equal(act({ status: 'ready' }, { aiAvailable: false }).kind, 'write_description');
  assert.deepEqual(act({ status: 'ready', publicationDescription: 'Opis' }), { kind: 'feed_cover', label: 'Brak okładki do feedu', tone: 'attention' });
  assert.equal(act({ status: 'ready', publicationDescription: 'Opis', feedCoverDone: true }).kind, 'schedule');
  assert.deepEqual(act({ status: 'ready', publicationDescription: 'Opis', feedCoverDone: true }, { planLabel: 'Jutro, Rano' }),
    { kind: 'reschedule', label: 'Termin: Jutro, Rano · Zmień termin', tone: 'quiet' }, 'a completed stage does not compete as a primary CTA');
});

test('Wybierz hook is only a quiet shortcut, and only before production', () => {
  assert.deepEqual(act({ status: 'idea' }), { kind: 'select_hook', label: 'Wybierz hook', tone: 'quiet' });
  assert.equal(act({ status: 'to_record' }).kind, 'select_hook');
  assert.equal(act({ status: 'idea', selectedHookId: 'h1' }), null);
  assert.equal(act({ status: 'editing', currentExport: { revision: 1 }, verificationState: 'verified' }), null);
});

test('App maps every rule kind to existing work and passes readOnly; Detail suppresses edit/generation when read-only', () => {
  const app = read('../../app/App.tsx');
  assert.ok(app.includes('detailPrimaryAction({'));
  for (const kind of ['restore', 'develop', 'write_script', 'add_export', 'reverify_export', 'generate_publication', 'write_description', 'feed_cover', 'schedule', 'reschedule', 'select_hook']) {
    assert.match(app, new RegExp(`\\n\\s+${kind}: `), `${kind} is handled`);
  }
  assert.ok(app.includes('readOnly={readOnly}'));
  assert.equal(/else if \(reel\.hooks\.length > 0 && !reel\.selectedHookId\)/.test(app), false, 'the scattered rule chain is gone');
  const screen = read('../../screens/ReelDetailScreen.tsx');
  assert.ok(screen.includes("{!readOnly ? <div className={styles.aiRow}"), 'no AI row on a deleted Reel');
  assert.ok(screen.includes('{!readOnly ? <div className={styles.secondarySections}>'), 'no production/publication editing on a deleted Reel');
  assert.ok(screen.includes('{readOnly ? null : <ReelOverflow {...overflow} />}'));
  assert.ok(screen.includes('readOnly={readOnly}'), 'fields become read-only');
  const banner = between(read('../../ui/detail-sections.tsx'), 'export function RestoreBanner', '\n}');
  assert.equal(banner.includes('onRestore'), false, 'Przywróć is not duplicated in the banner');
});

// ── F. publication hierarchy ──────────────────────────────────────────────────────────────

test('publication action hierarchy follows available content', () => {
  assert.deepEqual(publicationEmphasis('', ''), { generate: 'primary', copy: 'quiet', ready: false });
  assert.deepEqual(publicationEmphasis('', '#tag'), { generate: 'primary', copy: 'primary', ready: false });
  assert.deepEqual(publicationEmphasis('Opis', ''), { generate: 'quiet', copy: 'primary', ready: true });
  const section = read('../../screens/PublicationSection.tsx');
  assert.ok(section.includes('<ActionButton tone={emphasis.generate}'));
  assert.ok(section.includes("tone={emphasis.copy === 'primary' ? 'primary' : 'quiet'}"));
  assert.ok(section.includes('aria-label="Opis publikacji"') && section.includes('aria-label="Hashtagi"'), 'OPIS and HASHTAGI stay separate fields');
});

test('the proposal shows ŹRÓDŁA only from returned provenance, and generation still needs explicit apply', () => {
  const workspace = read('../../screens/AiWorkspace.tsx');
  const sources = between(workspace, '{pub.publicationGrounding ? <Section label="ŹRÓDŁA">', '</Section> : null}');
  assert.ok(sources.includes('(pub.publicationSources ?? []).map((item) =>'));
  assert.ok(sources.includes('href={item.url}'));
  assert.equal(/publicationDescriptionSuggestion/.test(sources), false, 'links are never taken from the generated text');
  assert.ok(workspace.includes(">Zastosuj</button>"), 'apply remains explicit per field');
  assert.ok(workspace.includes("'Zastąp opis'"), 'replacement still asks first');
});

// ── E. identity ───────────────────────────────────────────────────────────────────────────

test('opaque URL tokens are not presented as titles; readable data wins; the original is untouched', () => {
  for (const url of ['https://www.instagram.com/reel/h7v9vwm/', 'https://www.instagram.com/p/azIr67Xq2v/', 'https://www.tiktok.com/live']) {
    assert.match(urlLabel(url), /^Materiał z /, url);
  }
  assert.equal(urlLabel('https://example.test/rzad-przyjal-ustawe-2026'), 'rzad przyjal ustawe 2026');
  const original = { url: 'https://www.instagram.com/reel/h7v9vwm/', images: [] };
  const frozen = JSON.stringify(original);
  const label = reelLabel({ title: '', originalInput: original, script: 'Od stycznia bilety zdrożeją o 19 zł. Sprawdźmy dlaczego.' });
  assert.deepEqual(label, { text: 'Od stycznia bilety zdrożeją o 19 zł', derived: true, sourceDomain: 'instagram.com' });
  assert.equal(JSON.stringify(original), frozen, 'original input is not rewritten');
  assert.equal(reelLabel({ title: '', originalInput: { text: 'Mój pomysł', images: [] }, script: 'Skrypt.' }).text, 'Mój pomysł', 'author words beat the script');
  assert.equal(reelLabel({ title: 'Tytuł', originalInput: original, script: 'Skrypt.' }).text, 'Tytuł');
  assert.ok(read('../../screens/ReelDetailScreen.tsx').includes("{titlePlaceholder ? 'Nadaj tytuł' : 'Edytuj tytuł'}"), 'a clear title-edit affordance');
});

// ── radial quick-action menu ─────────────────────────────────────────────────────────────

test('radial actions are small, state-aware and never AI or destructive', () => {
  assert.deepEqual(radialActions({ status: 'editing', planLabel: null }).map((a) => a.label), ['Zmień status', 'Zaplanuj', 'Przypisz', 'Więcej']);
  assert.deepEqual(radialActions({ status: 'ready', planLabel: 'Jutro, Rano' }).map((a) => a.label), ['Zmień status', 'Zmień termin', 'Przypisz', 'Więcej']);
  assert.deepEqual(radialActions({ status: 'published' }).map((a) => a.id), ['status', 'assign', 'more']);
  for (const status of ['idea', 'to_record', 'editing', 'ready', 'published']) {
    const labels = radialActions({ status }).map((a) => a.label).join(' ');
    assert.equal(/Opracuj|fakty|hook|opis|Usuń|Archiwizuj/i.test(labels), false, status);
  }
});

test('radial layout never clips at edges of 360 and 390 px screens', () => {
  for (const width of [360, 390, 1100]) {
    const viewport = { width, height: 740 };
    for (const anchor of [{ x: 4, y: 4 }, { x: width - 2, y: 20 }, { x: width / 2, y: 400 }, { x: 10, y: 736 }, { x: width - 5, y: 739 }]) {
      const layout = radialLayout(anchor, viewport, 4);
      for (const item of layout.items) {
        assert.ok(item.x >= 0 && item.y >= 0, `${width} ${JSON.stringify(anchor)} ${JSON.stringify(item)}`);
        assert.ok(item.x + RADIAL_ITEM_SIZE <= width && item.y + RADIAL_ITEM_SIZE <= viewport.height, `${width} ${JSON.stringify(anchor)} ${JSON.stringify(item)}`);
      }
      // Targets never overlap one another.
      for (let i = 1; i < layout.items.length; i += 1) {
        const a = layout.items[i - 1]; const b = layout.items[i];
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= RADIAL_ITEM_SIZE - 1, `${width} overlap`);
      }
    }
    assert.equal(radialLayout({ x: width / 2, y: 8 }, viewport, 4).below, true, 'flips below at the top edge');
    assert.equal(radialLayout({ x: width / 2, y: 400 }, viewport, 4).below, false);
  }
});

test('radial wiring: touch long-press opens it without Detail; mouse and keyboard keep the full sheet', () => {
  const gestures = read('../../ui/gestures.ts');
  assert.ok(gestures.includes('onLongPress(hold);'));
  assert.ok(gestures.includes('ref.current.suppressClick = true;'), 'a long-press still swallows the click that would open Detail');
  const list = read('../../screens/ReelListScreen.tsx');
  assert.ok(list.includes("if (pointerType === 'touch' && quickActions?.onOpenRadial) quickActions.onOpenRadial(item.id, { x, y });"));
  assert.ok(list.includes("event.key === 'ContextMenu'"), 'keyboard fallback kept');
  assert.ok(list.includes('className={styles.rowMore}'), 'a visible, non-gesture quick-actions affordance');
  const quick = read('../../screens/ReelQuickActions.tsx');
  const radial = between(quick, 'export function RadialQuickMenu', '\n}\n');
  assert.ok(radial.includes("if (event.key === 'Escape')") && radial.includes('onClick={onDismiss}'), 'outside tap and Escape close it');
  assert.ok(radial.includes("else onOpenSheet(item.id);"), 'Więcej opens the full sheet');
  for (const mutation of ['onSelectStatus', 'onSelectEditor', 'onConfirmDelete', 'onQuickAdvanceStatus']) {
    assert.equal(radial.includes(mutation), false, `the radial never mutates directly (${mutation})`);
  }
  const sheet = between(quick, 'export function ReelQuickActionsSheet', 'const RADIAL_GLYPH');
  for (const item of ['COPY.changeStatus', 'COPY.assignEditor', 'COPY.schedule', 'COPY.copyLink', 'COPY.kdriveOpen', 'COPY.deleteReel']) {
    assert.ok(sheet.includes(item), `${item} remains reachable without the gesture`);
  }
});

// ── semantic colour, destructive, planner, layout ────────────────────────────────────────

const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('source text is readable reference content (≥ 7:1), not faded', () => {
  const tokens = read('../../ui/tokens.css');
  const reference = tokens.match(/--sz-color-text-reference: (#[0-9a-f]{6})/i)[1];
  const background = tokens.match(/--sz-color-background: (#[0-9a-f]{6})/i)[1];
  assert.ok(contrast(reference, background) >= 7, `contrast ${contrast(reference, background).toFixed(2)}`);
  const css = read('../../ui/detail-sections.module.css');
  const sourceText = between(css, '.sourceText {', '}');
  assert.ok(sourceText.includes('var(--sz-color-text-reference)'));
  assert.equal(/opacity/.test(between(css, '.subheading {', '}') + between(css, '.microLabel {', '}') + sourceText), false, 'no opacity fading on sources');
  for (const role of ['action', 'complete', 'attention', 'danger']) assert.ok(tokens.includes(`--sz-color-${role}:`), role);
});

test('the final Delete action is destructive red in Detail and in the list sheet', () => {
  for (const file of ['../../ui/detail-sections.tsx', '../../screens/ReelQuickActions.tsx']) {
    const source = read(file);
    assert.ok(source.includes('<ActionButton tone="danger" onClick={onConfirmDelete}>{COPY.deleteConfirm}</ActionButton>'), file);
  }
  assert.ok(read('../../ui/primitives.module.css').includes(".actionButton[data-tone='danger'] { background: var(--sz-color-danger);"));
});

test('planner empty state is accurate and DZIŚ is marked by more than colour', () => {
  assert.equal(unscheduledEmptyLabel([]), 'Brak rolek do nagrania, w montażu ani gotowych.');
  assert.equal(unscheduledEmptyLabel([{ status: 'published', deletedAt: null }, { status: 'idea', deletedAt: null }]), 'Brak rolek do nagrania, w montażu ani gotowych.');
  assert.equal(unscheduledEmptyLabel([{ status: 'editing', deletedAt: null }]), 'Każda rolka w produkcji ma już termin.');
  const css = read('../../screens/PlannerPane.module.css');
  assert.ok(between(css, ".group[data-today='true'] {", '}').includes('box-shadow: inset 3px 0 0 var(--sz-color-action)'));
  assert.equal(read('../../screens/PlannerPane.tsx').includes('Wszystko w produkcji ma termin'), false);
});

test('desktop panes stay structurally unchanged; only surfaces and boundary differ', () => {
  const css = read('../../app/App.css');
  assert.ok(css.includes(".workspace[data-layout='two'] { grid-template-columns: minmax(270px, 320px) minmax(0, 1fr); }"));
  assert.ok(css.includes(".workspace[data-layout='focus'] { grid-template-columns: minmax(0, 1fr); }"));
  assert.ok(css.includes('.workspace-centre { --sz-color-background: var(--sz-color-editor-surface'));
  const app = read('../../app/App.tsx');
  assert.ok(app.includes("<button type=\"button\" aria-pressed={leftView === 'plan'} onClick={() => setLeftView('plan')}>Plan</button>"), 'Plan switch kept');
  assert.ok(app.includes('>Skupienie</button>'), 'focus mode kept');
});

test('mobile Detail keeps 44px targets while tightening the space before the work', () => {
  const css = read('../../screens/ReelDetailScreen.module.css');
  assert.ok(between(css, '.screen {', '}').includes('gap: var(--sz-space-3);'));
  assert.ok(between(css, '.hookSelect {', '}').includes('min-height: var(--sz-touch-target)'));
  assert.ok(between(css, '.contextAction {', '}').includes('min-height: var(--sz-touch-target)'));
  assert.ok(read('../../ui/detail-sections.module.css').includes('min-height: 44px'));
});

test('the Polish meme file control replaces the browser-default English presentation', () => {
  const picker = read('../../screens/MemePicker.tsx');
  assert.ok(picker.includes("{file ? 'Zmień zdjęcie' : 'Wybierz zdjęcie'}") && picker.includes("'Nie wybrano pliku'"));
  assert.ok(read('../../screens/MemePicker.module.css').includes('.fileInput{position:absolute;width:1px;height:1px;opacity:0'));
  assert.equal(/#2e633d/.test(read('../../screens/MemePicker.module.css') + read('../../screens/AiWorkspace.module.css')), false, 'no completion-green action colour');
});
