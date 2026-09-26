import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { kdriveCommandMessage, kdriveFolderView, kdriveWebUrl, parseKdriveFolderInput } from '../kdrive.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const stored = { driveId: '1990403', folderId: '1381' };

test('web link matches the API form', () => {
  assert.equal(kdriveWebUrl('1990403', '1381'), 'https://ksuite.infomaniak.com/kdrive/app/drive/1990403/files/1381');
});

test('relink accepts a numeric id or a kDrive folder link, nothing else', () => {
  assert.equal(parseKdriveFolderInput(' 1381 '), '1381');
  assert.equal(parseKdriveFolderInput('https://ksuite.infomaniak.com/kdrive/app/drive/1990403/files/1381'), '1381');
  assert.equal(parseKdriveFolderInput('https://kdrive.infomaniak.com/app/drive/1990403/files/1349/'), '1349');
  assert.equal(parseKdriveFolderInput('https://evil.example.com/drive/1/files/1381'), null);
  assert.equal(parseKdriveFolderInput('https://ksuite.infomaniak.com/kdrive/app/drive/1990403'), null);
  assert.equal(parseKdriveFolderInput('folder'), null);
  assert.equal(parseKdriveFolderInput(''), null);
  assert.equal(parseKdriveFolderInput(null), null);
});

test('folder view: no folder, checking, available, missing, denied, transient', () => {
  assert.deepEqual(kdriveFolderView(null, undefined), { name: null, unavailable: false, note: null, webUrl: null });
  assert.equal(kdriveFolderView(stored, { state: 'loading' }).note, 'Sprawdzanie folderu…');
  const available = kdriveFolderView(stored, { state: 'available', driveId: '1990403', folderId: '1381', name: 'Tramwaje [1a2b3c4d]', webUrl: 'https://x/1381' });
  assert.deepEqual(available, { name: 'Tramwaje [1a2b3c4d]', unavailable: false, note: null, webUrl: 'https://x/1381' });
  const missing = kdriveFolderView(stored, { state: 'missing', driveId: '1990403', folderId: '1381', webUrl: 'https://x/1381', retryable: false });
  assert.equal(missing.unavailable, true, 'missing offers relink');
  assert.equal(missing.name, 'Folder 1381', 'the stored reference stays visible');
  assert.equal(kdriveFolderView(stored, { state: 'access_denied', driveId: '1990403', folderId: '1381', webUrl: 'u', retryable: false }).unavailable, true);
  const transient = kdriveFolderView(stored, { state: 'unavailable', driveId: '1990403', folderId: '1381', webUrl: 'u', retryable: true });
  assert.equal(transient.unavailable, false, 'a temporary outage keeps Open, not relink');
  assert.ok(transient.note);
});

test('command failures read as specific Polish messages', () => {
  assert.match(kdriveCommandMessage({ api: { code: 'PROVIDER_UNAVAILABLE', details: { reason: 'kdrive_not_configured' } } }), /nie jest skonfigurowana/);
  assert.match(kdriveCommandMessage({ api: { code: 'VALIDATION_ERROR', details: { reason: 'already_linked' } } }), /ma już folder/);
  assert.match(kdriveCommandMessage({ api: { code: 'PROVIDER_RESOURCE_MISSING' } }), /Nie znaleziono/);
  assert.match(kdriveCommandMessage({ api: { code: 'PROVIDER_UNAVAILABLE', details: { reason: 'unavailable' } } }), /Nic nie zostało zmienione/);
  assert.match(kdriveCommandMessage(undefined), /Spróbuj ponownie/);
});

test('App wiring: no hard-coded kDrive switch-off; the schedule sheet never shares the Detail key', () => {
  const app = readFileSync(path.join(here, '../../app/App.tsx'), 'utf8');
  assert.ok(!/KDRIVE_ENABLED\s*=\s*false/.test(app));
  assert.ok(!/onCreateKdriveFolder:\s*\(\)\s*=>\s*c\.setMessage\(COPY\.kdriveUnavailable\)/.test(app));
  // Regression (duplicate Detail on mobile): the sheet renders beside the Detail keyed by reel.id.
  assert.ok(/key=\{reel\.id\}/.test(app));
  assert.ok(!/key=\{scheduleReel\.id\}/.test(app));
  assert.ok(/key=\{`schedule:\$\{scheduleReel\.id\}`\}/.test(app));
});
