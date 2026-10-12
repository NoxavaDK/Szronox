/**
 * HOOKS-SELECT-EDIT boundary checks for the web client.
 *
 * This package has no DOM renderer, so the HOOKI row structure and controller wiring are
 * asserted on source, as in publication-generation.test.mjs. Server behaviour is covered by
 * apps/api/src/hooks-selection.test.ts. Run: node --experimental-strip-types --test src/data/tests/*.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, relative), 'utf8');
const between = (source, start, end) => {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} … ${end} not found`);
  return source.slice(from, to);
};

test('selection uses its own versioned route; edits reuse the existing hook PATCH', () => {
  const api = read('../api.ts');
  assert.match(api, /selectHook = \(id: string, body: SelectHookRequest\) => this\.request<SelectHookResponse>\(`\/reels\/\$\{id\}\/selected-hook`, \{ method: 'PUT'/);
  assert.match(api, /editHook = \(id: string, hookId: string, body: EditHookRequest\) => this\.request<Reel>\(`\/reels\/\$\{id\}\/hooks\/\$\{hookId\}`, \{ method: 'PATCH'/);
  assert.equal((api.match(/\/hooks\/\$\{hookId\}`/g) ?? []).length, 2, 'no second hook-edit endpoint');
});

test('a HOOKI row selects on the row itself; edit and delete are sibling controls', () => {
  const screen = read('../../screens/ReelDetailScreen.tsx');
  const row = between(screen, 'className={styles.hookSelect}', 'aria-label="Usuń hook"');
  const selectButton = between(row, 'className={styles.hookSelect}', '</button>');
  assert.ok(selectButton.includes('aria-pressed={selected}'), 'selected state is exposed to assistive tech');
  assert.ok(selectButton.includes('onClick={() => onSelectHook(hook.id)}'));
  assert.equal(selectButton.includes('onStartHookEdit'), false, 'edit is not inside the select target');
  assert.equal(selectButton.includes('onRemoveHook'), false, 'delete is not inside the select target');
  assert.ok(row.indexOf('aria-label="Edytuj hook"') > row.indexOf('</button>'), 'edit control follows the closed select button');
  // UI-02: a visible radio-style mark plus the WYBRANY label — never colour alone.
  assert.ok(selectButton.includes("<span className={styles.hookMark} data-selected={selected ? 'true' : undefined} aria-hidden=\"true\">"));
  assert.ok(selectButton.includes('{selected ? <CheckIcon size={12} /> : null}'));
  assert.ok(selectButton.includes('{selected ? <span className={styles.hookSelectedTag}>Wybrany</span> : null}'));
  // Both labels can appear together: provenance is not conditioned on selection.
  assert.ok(selectButton.includes('{own}'));
  assert.ok(screen.includes("const own = hook.source === 'user' ? <span className={styles.hookOwnTag}>własny</span> : null;"));
  // One concise instruction instead of a second `Wybierz hook` action inside HOOKI.
  assert.ok(screen.includes('Stuknij hook, aby go wybrać'));
  assert.equal(screen.includes('hookChooseAction'), false);
  // Scoped to the hook row itself: CAPTURE-DRAFT-01 adds an unrelated "Użyj" action (applying
  // the auto-draft title suggestion) well above this section, which this must not catch.
  assert.equal(row.includes('Użyj'), false, 'no per-hook use action');
});

test('inline edit offers Gotowe and Anuluj, and keeps an orphaned draft visible', () => {
  const screen = read('../../screens/ReelDetailScreen.tsx');
  assert.ok(screen.includes("'Gotowe'") && screen.includes("'Anuluj'"));
  assert.ok(screen.includes('.filter(([id]) => !hooks.some((hook) => hook.id === id))'));
});

test('selected styling is explicit and not a text highlight', () => {
  const css = read('../../screens/ReelDetailScreen.module.css');
  const selected = between(css, '.hookRowSelected {', '}');
  assert.ok(selected.includes('box-shadow: inset 3px 0 0 var(--sz-color-action)'));
  assert.ok(between(css, ".hookMark[data-selected='true'] {", '}').includes('background: var(--sz-color-action)'), 'filled check mark when chosen');
  assert.equal(/purple|violet|::selection|color:/i.test(selected), false, 'no coloured text as state');
  assert.ok(between(css, '.hookSelect {', '}').includes('min-height: var(--sz-touch-target)'), 'generous target');
  assert.ok(between(css, '.hookSelect {', '}').includes('user-select: none'), 'state never depends on text selection');
});

test('the controller never loses an inline draft and never selects implicitly', () => {
  const controller = read('../../controllers/useAppController.ts');
  const save = between(controller, 'const saveHookEdit = useCallback(', 'const deleteCurrent = useCallback(');
  const success = between(save, 'const saved = await api.editHook(', '} catch (error) {');
  assert.ok(success.includes('updateHookEdit(hookId, () => null)'), 'draft is dropped only after the server confirmed');
  const failure = save.slice(save.indexOf('} catch (error) {'));
  assert.equal(failure.includes('() => null'), false, 'a failed save keeps the draft');
  assert.equal(/text:/.test(failure), false, 'a failed save never replaces the typed text');
  assert.ok(failure.includes('refreshAfterRefusal(reel)'), 'conflict refreshes the version for a truthful retry');

  const select = between(controller, 'const selectHook = useCallback(', 'const updateHookEdit = useCallback(');
  assert.equal(select.includes('store.enqueue'), false, 'a selection is never claimed as saved offline');
  assert.ok(select.includes('Wybór hooka nie został zapisany'));

  // Capture and the queue send no selection; only the explicit route does.
  assert.equal((controller.match(/selectedHookId/g) ?? []).length, 0);
  const app = read('../../app/App.tsx');
  assert.ok(app.includes('onSelectHook={(id) => void c.selectHook((reel.selectedHookId ?? null) === id ? null : id)}'));
});

test('Opracowanie hook generation is unchanged', () => {
  const workspace = read('../../screens/AiWorkspace.tsx');
  assert.ok(workspace.includes("onClick={() => onSwitch('generate_hooks', true)}>+ Wygeneruj więcej</button>"));
  assert.equal(workspace.includes('selectHook'), false);
});
