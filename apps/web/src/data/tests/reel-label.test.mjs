import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LABEL_LENGTH,
  UNTITLED_LABEL,
  captureLabel,
  imageCountLabel,
  reelLabel,
  urlLabel,
} from '../reel-label.ts';

/**
 * Labels for untitled Reels.
 *
 * The bug: `POST /reels` stores `original_input` and leaves `title` at its SQL default of
 * `''`, and the list rendered `reel.title` directly — so a shared link, or any capture saved
 * without a title, produced a tappable but blank row. These tests pin both halves of the fix:
 * that a meaningful label is derived from data already in hand, and that an authored title and
 * the original input are left exactly as they are.
 */

/** Only the two fields the label reads; the rest of a Reel is irrelevant to it. */
const reel = (title, originalInput) => ({ title, originalInput });

test('an authored title wins outright and is returned exactly as stored', () => {
  assert.deepEqual(
    reelLabel(reel('Rolka o rowerach', { images: [] })),
    { text: 'Rolka o rowerach', derived: false },
  );

  // Not tidied, not truncated, not collapsed: the list must agree with the title field
  // character for character, or editing the title would look like it changed something else.
  const odd = '  Tytuł   z   odstępami  ';
  assert.equal(reelLabel(reel(odd, { images: [] })).text, odd);

  // A very long authored title is still the author's title.
  const long = 'x'.repeat(MAX_LABEL_LENGTH + 40);
  assert.deepEqual(reelLabel(reel(long, { images: [] })), { text: long, derived: false });
});

test('a whitespace-only title is not a title', () => {
  const result = reelLabel(reel('   \n\t ', { images: [], text: 'Pomysł na rolkę' }));
  assert.deepEqual(result, { text: 'Pomysł na rolkę', derived: true });
});

test('a link-only capture is labelled by its URL, not left blank', () => {
  // The reported case: a shared link stores no text, so title stayed '' and the row was blank.
  const result = reelLabel(reel('', { images: [], url: 'https://www.instagram.com/reel/ABC123/' }));
  assert.deepEqual(result, { text: 'instagram.com/reel/ABC123', derived: true });
});

test('a URL is shortened to host and path, and marked as derived', () => {
  assert.equal(urlLabel('https://www.example.test/a/b/'), 'example.test/a/b');
  assert.equal(urlLabel('https://example.test'), 'example.test');
  assert.equal(urlLabel('https://example.test/'), 'example.test');
  // Query and fragment are dropped: usually tracking noise, and they would push the
  // meaningful part of the label past the row's ellipsis.
  assert.equal(urlLabel('https://example.test/artykul?utm_source=x&utm_campaign=y#top'), 'example.test/artykul');
  // A port is part of the host and is kept.
  assert.equal(urlLabel('http://example.test:8080/a'), 'example.test:8080/a');
  // Not a URL, or not an http(s) one: shown as given rather than mangled or dropped.
  assert.equal(urlLabel('nie-jest-adresem'), 'nie-jest-adresem');
  assert.equal(urlLabel('mailto:kto@example.test'), 'mailto:kto@example.test');
});

test('shared text wins over the URL, because it is what the person wrote', () => {
  const result = reelLabel(reel('', {
    images: [],
    text: 'Zobacz ten materiał o transporcie',
    url: 'https://example.test/x',
  }));
  assert.deepEqual(result, { text: 'Zobacz ten materiał o transporcie', derived: true });
});

test('text that is nothing but a bare URL is labelled as a URL', () => {
  // What an Android share of a link usually produces: the link arrives in `text`.
  const result = captureLabel({ images: [], text: 'https://www.example.test/a/long/path' });
  assert.equal(result, 'example.test/a/long/path');
});

test('a multi-line share is labelled by its first non-empty line', () => {
  assert.equal(
    captureLabel({ images: [], text: '\n\n  Pierwsza linia  \nDruga linia\n' }),
    'Pierwsza linia',
  );
});

test('internal whitespace is collapsed and a long label is cut with an ellipsis', () => {
  assert.equal(captureLabel({ images: [], text: 'dwa   słowa\tz\ttabami' }), 'dwa słowa z tabami');

  const label = captureLabel({ images: [], text: 'a '.repeat(200) });
  assert.equal(label.length, MAX_LABEL_LENGTH);
  assert.equal(label.endsWith('…'), true);

  // Exactly at the limit: nothing is cut and no ellipsis is added.
  const exact = 'b'.repeat(MAX_LABEL_LENGTH);
  assert.equal(captureLabel({ images: [], text: exact }), exact);
});

test('accompanying text is used when there is no shared text', () => {
  const result = captureLabel({
    images: [],
    additionalText: 'Mój komentarz do linku',
    url: 'https://example.test/x',
  });
  assert.equal(result, 'Mój komentarz do linku');
});

test('an image-only capture is labelled by its file name', () => {
  const result = reelLabel(reel('', {
    images: [
      { attachmentId: 'a1', fileName: 'wykres-emisji.png', mimeType: 'image/png', byteSize: 10 },
      { attachmentId: 'a2', fileName: 'drugie.jpg', mimeType: 'image/jpeg', byteSize: 10 },
    ],
  }));
  // Real data the user recognises, preferred over a count of files.
  assert.deepEqual(result, { text: 'wykres-emisji.png', derived: true });
});

test('images with no usable names fall back to a correctly pluralised count', () => {
  const unnamed = (count) => Array.from({ length: count }, (_, index) => ({
    attachmentId: `a${index}`, fileName: '  ', mimeType: 'image/png', byteSize: 10,
  }));
  assert.equal(captureLabel({ images: unnamed(1) }), '1 zdjęcie');
  assert.equal(captureLabel({ images: unnamed(3) }), '3 zdjęcia');
  assert.equal(captureLabel({ images: unnamed(6) }), '6 zdjęć');
});

test('Polish plural forms are right, including the 12–14 exception', () => {
  assert.equal(imageCountLabel(1), '1 zdjęcie');
  assert.equal(imageCountLabel(2), '2 zdjęcia');
  assert.equal(imageCountLabel(4), '4 zdjęcia');
  assert.equal(imageCountLabel(5), '5 zdjęć');
  assert.equal(imageCountLabel(12), '12 zdjęć');
  assert.equal(imageCountLabel(13), '13 zdjęć');
  assert.equal(imageCountLabel(14), '14 zdjęć');
  assert.equal(imageCountLabel(22), '22 zdjęcia');
  assert.equal(imageCountLabel(25), '25 zdjęć');
});

test('an original shared field is the last resort before Bez tytułu', () => {
  const result = captureLabel({
    images: [],
    originalShare: {
      fields: [
        { name: 'text', value: '' },
        { name: 'nieznane', value: 'Coś jednak przyszło' },
      ],
      files: [],
    },
  });
  assert.equal(result, 'Coś jednak przyszło');
});

test('a capture with nothing usable says so rather than rendering blank', () => {
  assert.equal(captureLabel({ images: [] }), UNTITLED_LABEL);
  assert.equal(captureLabel({ images: [], text: '   ', url: '  ' }), UNTITLED_LABEL);
  assert.equal(reelLabel(reel('', { images: [] })).text, UNTITLED_LABEL);
});

test('deriving a label never alters the capture it reads', () => {
  const input = {
    images: [{ attachmentId: 'a1', fileName: 'p.png', mimeType: 'image/png', byteSize: 10 }],
    text: '  https://www.example.test/a?utm_source=x  ',
    url: 'https://www.example.test/a?utm_source=x',
    originalShare: { fields: [{ name: 'text', value: '  raw  ' }], files: [] },
  };
  const snapshot = structuredClone(input);
  const label = reelLabel(reel('', input));

  assert.equal(label.derived, true);
  // The label is shortened; the capture is not. The exact URL, the untrimmed text and the
  // original shared fields all survive for the detail screen and for any later processing.
  assert.equal(label.text, 'example.test/a');
  assert.deepEqual(input, snapshot);
});
