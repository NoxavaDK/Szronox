/**
 * Deterministic PDF page-text extraction.
 *
 * Every citation this product serves claims a physical page of an archived file. That
 * claim is only worth something if the server can re-derive, from those exact bytes, what
 * text is on that page — so extraction lives here, in the application, rather than in an
 * operator's spreadsheet. The same bytes always produce the same text, and the text is
 * never repaired, guessed at or completed by a model.
 *
 * Scope is deliberately narrow, because a general PDF reader is a much larger and much
 * less auditable thing than this task needs:
 *
 *   - classic cross-reference tables, with a whole-file object scan as the fallback;
 *   - FlateDecode streams (the only filter the archived source uses);
 *   - simple fonts and Identity-H composite fonts, decoded through /ToUnicode where the
 *     file supplies one, and through WinAnsi/MacRoman/Standard plus /Differences where it
 *     does not;
 *   - the text-showing operators, with positions from the text and current transformation
 *     matrices and advances from the font's own /Widths.
 *
 * What it does NOT do is guess. A byte it cannot decode becomes U+FFFD and is counted, an
 * unsupported filter or a form XObject is reported as a warning, and the validator treats
 * either as an extraction failure for any passage that depends on it. Failing loudly on a
 * page nobody has proof-read is the point: a silent mis-decode would put invented words
 * inside a verbatim quotation.
 */

import { inflateSync } from 'node:zlib';

export interface PdfPageText {
  /** 1-based physical page index. */
  pdfPage: number;
  text: string;
  /** Codes that no encoding in the file could resolve; each became U+FFFD. */
  undecodedCount: number;
}

export interface PdfExtraction {
  pages: PdfPageText[];
  pageCount: number;
  /** Structural facts a reader needs to interpret the result. Never a repair. */
  warnings: string[];
}

export class PdfExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfExtractionError';
  }
}

/* ── Object model ─────────────────────────────────────────────────────────────── */

export interface PdfRef { ref: number }
export interface PdfName { name: string }
export interface PdfStream { dict: PdfDict; raw: Buffer }
export type PdfDict = Map<string, PdfValue>;
export type PdfValue =
  | null | boolean | number | string
  | PdfName | PdfRef | PdfValue[] | PdfDict | PdfStream;

const isRef = (value: PdfValue): value is PdfRef =>
  typeof value === 'object' && value !== null && 'ref' in value;
const isName = (value: PdfValue): value is PdfName =>
  typeof value === 'object' && value !== null && 'name' in value;
const isDict = (value: PdfValue): value is PdfDict => value instanceof Map;
const isStream = (value: PdfValue): value is PdfStream =>
  typeof value === 'object' && value !== null && 'dict' in value && 'raw' in value;

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITER = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const isRegular = (byte: number) => !WHITESPACE.has(byte) && !DELIMITER.has(byte);

/**
 * Lexer/parser over a PDF byte range.
 *
 * One class serves both file objects and content streams; content streams have no
 * indirect references, so the `R` lookahead simply never fires there.
 */
class PdfLexer {
  position: number;

  constructor(private readonly bytes: Buffer, start = 0) {
    this.position = start;
  }

  atEnd(): boolean { return this.position >= this.bytes.length; }

  skipSpace(): void {
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position];
      if (WHITESPACE.has(byte)) { this.position += 1; continue; }
      if (byte === 0x25) { // % comment to end of line
        while (this.position < this.bytes.length && this.bytes[this.position] !== 0x0a && this.bytes[this.position] !== 0x0d) {
          this.position += 1;
        }
        continue;
      }
      return;
    }
  }

  /** The next token as raw text: a keyword, operator or number. */
  readKeyword(): string {
    const start = this.position;
    while (this.position < this.bytes.length && isRegular(this.bytes[this.position])) this.position += 1;
    if (this.position === start) { this.position += 1; return this.bytes.toString('latin1', start, this.position); }
    return this.bytes.toString('latin1', start, this.position);
  }

  readName(): PdfName {
    this.position += 1; // '/'
    const start = this.position;
    while (this.position < this.bytes.length && isRegular(this.bytes[this.position])) this.position += 1;
    const raw = this.bytes.toString('latin1', start, this.position);
    return { name: raw.replace(/#([0-9a-fA-F]{2})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16))) };
  }

  /** A literal `(...)` string, returned as raw bytes in a latin1 string. */
  readLiteralString(): string {
    this.position += 1;
    let depth = 1;
    const out: number[] = [];
    while (this.position < this.bytes.length) {
      const byte = this.bytes[this.position];
      this.position += 1;
      if (byte === 0x5c) { // backslash
        const next = this.bytes[this.position];
        this.position += 1;
        if (next === 0x6e) out.push(0x0a);
        else if (next === 0x72) out.push(0x0d);
        else if (next === 0x74) out.push(0x09);
        else if (next === 0x62) out.push(0x08);
        else if (next === 0x66) out.push(0x0c);
        else if (next >= 0x30 && next <= 0x37) {
          let value = next - 0x30;
          for (let index = 0; index < 2; index += 1) {
            const digit = this.bytes[this.position];
            if (digit === undefined || digit < 0x30 || digit > 0x37) break;
            value = value * 8 + (digit - 0x30);
            this.position += 1;
          }
          out.push(value & 0xff);
        } else if (next === 0x0a) { /* line continuation */ }
        else if (next === 0x0d) { if (this.bytes[this.position] === 0x0a) this.position += 1; }
        else out.push(next);
        continue;
      }
      if (byte === 0x28) { depth += 1; out.push(byte); continue; }
      if (byte === 0x29) { depth -= 1; if (depth === 0) break; out.push(byte); continue; }
      out.push(byte);
    }
    return Buffer.from(out).toString('latin1');
  }

  readHexString(): string {
    this.position += 1;
    const digits: string[] = [];
    while (this.position < this.bytes.length && this.bytes[this.position] !== 0x3e) {
      const char = String.fromCharCode(this.bytes[this.position]);
      if (/[0-9a-fA-F]/.test(char)) digits.push(char);
      this.position += 1;
    }
    this.position += 1;
    if (digits.length % 2 === 1) digits.push('0');
    const out: number[] = [];
    for (let index = 0; index < digits.length; index += 2) out.push(parseInt(digits[index] + digits[index + 1], 16));
    return Buffer.from(out).toString('latin1');
  }

  /**
   * Parse one object.
   *
   * `resolveLength` is supplied when parsing file objects so a stream whose /Length is an
   * indirect reference can still be bounded; content-stream parsing passes nothing.
   */
  parseValue(resolveLength?: (value: PdfValue) => number | null): PdfValue {
    this.skipSpace();
    if (this.atEnd()) throw new PdfExtractionError('Unexpected end of PDF object');
    const byte = this.bytes[this.position];
    if (byte === 0x2f) return this.readName();
    if (byte === 0x28) return this.readLiteralString();
    if (byte === 0x5b) { // array
      this.position += 1;
      const items: PdfValue[] = [];
      for (;;) {
        this.skipSpace();
        if (this.atEnd()) throw new PdfExtractionError('Unterminated PDF array');
        if (this.bytes[this.position] === 0x5d) { this.position += 1; return items; }
        items.push(this.parseValue(resolveLength));
      }
    }
    if (byte === 0x3c) {
      if (this.bytes[this.position + 1] === 0x3c) return this.parseDictOrStream(resolveLength);
      return this.readHexString();
    }
    if (byte === 0x5d || byte === 0x3e || byte === 0x7d || byte === 0x29) {
      throw new PdfExtractionError('Unbalanced PDF delimiter');
    }
    const start = this.position;
    const keyword = this.readKeyword();
    if (keyword === 'true') return true;
    if (keyword === 'false') return false;
    if (keyword === 'null') return null;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(keyword)) {
      // `N G R` is an indirect reference; `N G obj` is handled by the caller.
      const save = this.position;
      if (/^\d+$/.test(keyword)) {
        this.skipSpace();
        const generation = this.readKeyword();
        if (/^\d+$/.test(generation)) {
          this.skipSpace();
          const marker = this.readKeyword();
          if (marker === 'R') return { ref: Number(keyword) };
        }
      }
      this.position = save;
      return Number(keyword);
    }
    if (keyword === '') { this.position = start + 1; return null; }
    return { name: `__keyword__${keyword}` };
  }

  private parseDictOrStream(resolveLength?: ((value: PdfValue) => number | null) | undefined): PdfDict | PdfStream {
    this.position += 2;
    const dict: PdfDict = new Map();
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) throw new PdfExtractionError('Unterminated PDF dictionary');
      if (this.bytes[this.position] === 0x3e && this.bytes[this.position + 1] === 0x3e) {
        this.position += 2;
        break;
      }
      if (this.bytes[this.position] !== 0x2f) { this.parseValue(resolveLength); continue; }
      const key = this.readName().name;
      dict.set(key, this.parseValue(resolveLength));
    }
    const save = this.position;
    this.skipSpace();
    const keyword = this.readKeyword();
    if (keyword !== 'stream') { this.position = save; return dict; }
    if (this.bytes[this.position] === 0x0d) this.position += 1;
    if (this.bytes[this.position] === 0x0a) this.position += 1;
    const dataStart = this.position;
    const declared = resolveLength ? resolveLength(dict.get('Length') ?? null) : null;
    let dataEnd = declared !== null && declared >= 0 && dataStart + declared <= this.bytes.length
      ? dataStart + declared
      : -1;
    // A wrong or indirect /Length must not silently truncate a stream: confirm the
    // declared end really is followed by `endstream`, and search for it otherwise.
    if (dataEnd < 0 || !/^\s*endstream/.test(this.bytes.toString('latin1', dataEnd, dataEnd + 12))) {
      const found = this.bytes.indexOf('endstream', dataStart, 'latin1');
      if (found < 0) throw new PdfExtractionError('Unterminated PDF stream');
      dataEnd = found;
      while (dataEnd > dataStart && (this.bytes[dataEnd - 1] === 0x0a || this.bytes[dataEnd - 1] === 0x0d)) dataEnd -= 1;
    }
    const raw = this.bytes.subarray(dataStart, dataEnd);
    const after = this.bytes.indexOf('endstream', dataEnd, 'latin1');
    this.position = after < 0 ? dataEnd : after + 'endstream'.length;
    return { dict, raw: Buffer.from(raw) };
  }
}

/* ── Document ─────────────────────────────────────────────────────────────────── */

class PdfDocument {
  private readonly offsets = new Map<number, number>();
  private readonly cache = new Map<number, PdfValue>();
  readonly warnings: string[] = [];
  trailer: PdfDict = new Map();

  constructor(private readonly bytes: Buffer) {
    if (!this.bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
      throw new PdfExtractionError('File does not start with a PDF header');
    }
    if (!this.loadXref()) this.scanObjects();
    if (!this.trailer.has('Root')) this.findRootByScan();
  }

  resolve(value: PdfValue | undefined): PdfValue {
    let current: PdfValue = value ?? null;
    for (let depth = 0; depth < 32 && isRef(current); depth += 1) current = this.object(current.ref);
    return isRef(current) ? null : current;
  }

  dict(value: PdfValue | undefined): PdfDict | null {
    const resolved = this.resolve(value);
    if (isDict(resolved)) return resolved;
    if (isStream(resolved)) return resolved.dict;
    return null;
  }

  object(number: number): PdfValue {
    const cached = this.cache.get(number);
    if (cached !== undefined) return cached;
    const offset = this.offsets.get(number);
    if (offset === undefined) return null;
    this.cache.set(number, null); // break reference cycles while parsing
    const lexer = new PdfLexer(this.bytes, offset);
    lexer.skipSpace();
    const objectNumber = lexer.readKeyword();
    lexer.skipSpace();
    lexer.readKeyword();
    lexer.skipSpace();
    const marker = lexer.readKeyword();
    if (marker !== 'obj' || Number(objectNumber) !== number) return null;
    const value = lexer.parseValue((length) => {
      const resolved = this.resolve(length);
      return typeof resolved === 'number' ? resolved : null;
    });
    this.cache.set(number, value);
    return value;
  }

  /** Decoded stream bytes, or null when the filter chain is unsupported. */
  streamData(stream: PdfStream): Buffer | null {
    const filter = this.resolve(stream.dict.get('Filter'));
    const filters = filter === null ? [] : Array.isArray(filter) ? filter : [filter];
    let data = stream.raw;
    for (const entry of filters) {
      const resolved = this.resolve(entry);
      if (!isName(resolved)) return null;
      if (resolved.name === 'FlateDecode') {
        try { data = inflateSync(data); } catch { return null; }
        continue;
      }
      return null;
    }
    const parms = this.dict(stream.dict.get('DecodeParms'));
    if (parms && this.resolve(parms.get('Predictor')) !== null) {
      const predictor = this.resolve(parms.get('Predictor'));
      if (typeof predictor === 'number' && predictor > 1) return null;
    }
    return data;
  }

  private loadXref(): boolean {
    const tail = this.bytes.toString('latin1', Math.max(0, this.bytes.length - 2048));
    const match = /startxref\s+(\d+)\s*(?:%%EOF)?\s*$/.exec(tail.trimEnd());
    if (!match) return false;
    let offset: number | null = Number(match[1]);
    const seen = new Set<number>();
    let loaded = false;
    while (offset !== null && offset >= 0 && offset < this.bytes.length && !seen.has(offset)) {
      seen.add(offset);
      const lexer: PdfLexer = new PdfLexer(this.bytes, offset);
      lexer.skipSpace();
      if (lexer.readKeyword() !== 'xref') {
        // Cross-reference streams belong to PDF 1.5+ and are out of scope by design.
        this.warnings.push('Cross-reference stream is unsupported; fell back to an object scan.');
        return false;
      }
      for (;;) {
        lexer.skipSpace();
        const save = lexer.position;
        const first = lexer.readKeyword();
        if (first === 'trailer') break;
        lexer.skipSpace();
        const count = lexer.readKeyword();
        if (!/^\d+$/.test(first) || !/^\d+$/.test(count)) { lexer.position = save; break; }
        const start = Number(first);
        for (let index = 0; index < Number(count); index += 1) {
          lexer.skipSpace();
          const entryOffset = lexer.readKeyword();
          lexer.skipSpace();
          lexer.readKeyword();
          lexer.skipSpace();
          const type = lexer.readKeyword();
          if (type === 'n' && /^\d+$/.test(entryOffset) && !this.offsets.has(start + index)) {
            this.offsets.set(start + index, Number(entryOffset));
          }
        }
      }
      const trailer: PdfValue = lexer.parseValue((value: PdfValue) => (typeof value === 'number' ? value : null));
      offset = null;
      if (isDict(trailer)) {
        loaded = true;
        for (const [key, value] of trailer) if (!this.trailer.has(key)) this.trailer.set(key, value);
        const previous: PdfValue | undefined = trailer.get('Prev');
        if (typeof previous === 'number') offset = previous;
      }
    }
    return loaded && this.offsets.size > 0;
  }

  /** Fallback: every `N G obj` at a line start, last definition winning. */
  private scanObjects(): void {
    const text = this.bytes.toString('latin1');
    const pattern = /(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      this.offsets.set(Number(match[1]), match.index + (match[0].length - `${match[1]} ${match[2]} obj`.length));
    }
    const trailerIndex = text.lastIndexOf('trailer');
    if (trailerIndex >= 0) {
      const parsed = new PdfLexer(this.bytes, trailerIndex + 'trailer'.length)
        .parseValue((value) => (typeof value === 'number' ? value : null));
      if (isDict(parsed)) this.trailer = parsed;
    }
  }

  private findRootByScan(): void {
    for (const number of [...this.offsets.keys()].sort((left, right) => left - right)) {
      const dict = this.dict(this.object(number));
      const type = dict && this.resolve(dict.get('Type'));
      if (type !== null && isName(type) && type.name === 'Catalog') {
        this.trailer.set('Root', { ref: number });
        return;
      }
    }
    throw new PdfExtractionError('PDF has no document catalog');
  }

  /** Page dictionaries in reading order, with inherited attributes applied. */
  pages(): PdfDict[] {
    const catalog = this.dict(this.trailer.get('Root'));
    if (!catalog) throw new PdfExtractionError('PDF catalog is unreadable');
    const root = this.dict(catalog.get('Pages'));
    const out: PdfDict[] = [];
    const inheritable = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;
    const visited = new Set<PdfDict>();
    const walk = (node: PdfDict | null, inherited: PdfDict): void => {
      if (!node || visited.has(node) || out.length > 5000) return;
      visited.add(node);
      const merged: PdfDict = new Map(inherited);
      for (const key of inheritable) if (node.has(key)) merged.set(key, node.get(key) as PdfValue);
      const type = this.resolve(node.get('Type'));
      const kids = this.resolve(node.get('Kids'));
      if (Array.isArray(kids)) {
        for (const kid of kids) walk(this.dict(kid), merged);
        return;
      }
      if (isName(type) && type.name === 'Pages') return;
      const page: PdfDict = new Map(merged);
      for (const [key, value] of node) page.set(key, value);
      out.push(page);
    };
    walk(root, new Map());
    if (out.length === 0) {
      for (const number of [...this.offsets.keys()].sort((left, right) => left - right)) {
        const dict = this.dict(this.object(number));
        const type = dict && this.resolve(dict.get('Type'));
        if (dict && type !== null && isName(type) && type.name === 'Page') out.push(dict);
      }
      if (out.length > 0) this.warnings.push('Page tree was unreadable; pages were recovered by object order.');
    }
    if (out.length === 0) throw new PdfExtractionError('PDF has no pages');
    return out;
  }
}

/* ── Encodings ────────────────────────────────────────────────────────────────── */

/** 0x80–0xFF of WinAnsiEncoding, as Unicode code points. */
const WIN_ANSI_HIGH = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039,
  0x0152, 0x008d, 0x017d, 0x008f, 0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
  0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178, 0x00a0, 0x00a1, 0x00a2, 0x00a3,
  0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x00aa, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x00ba, 0x00bb,
  0x00bc, 0x00bd, 0x00be, 0x00bf, 0x00c0, 0x00c1, 0x00c2, 0x00c3, 0x00c4, 0x00c5, 0x00c6, 0x00c7,
  0x00c8, 0x00c9, 0x00ca, 0x00cb, 0x00cc, 0x00cd, 0x00ce, 0x00cf, 0x00d0, 0x00d1, 0x00d2, 0x00d3,
  0x00d4, 0x00d5, 0x00d6, 0x00d7, 0x00d8, 0x00d9, 0x00da, 0x00db, 0x00dc, 0x00dd, 0x00de, 0x00df,
  0x00e0, 0x00e1, 0x00e2, 0x00e3, 0x00e4, 0x00e5, 0x00e6, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb,
  0x00ec, 0x00ed, 0x00ee, 0x00ef, 0x00f0, 0x00f1, 0x00f2, 0x00f3, 0x00f4, 0x00f5, 0x00f6, 0x00f7,
  0x00f8, 0x00f9, 0x00fa, 0x00fb, 0x00fc, 0x00fd, 0x00fe, 0x00ff,
];

/** 0x80–0xFF of MacRomanEncoding, as Unicode code points. */
const MAC_ROMAN_HIGH = [
  0x00c4, 0x00c5, 0x00c7, 0x00c9, 0x00d1, 0x00d6, 0x00dc, 0x00e1, 0x00e0, 0x00e2, 0x00e4, 0x00e3,
  0x00e5, 0x00e7, 0x00e9, 0x00e8, 0x00ea, 0x00eb, 0x00ed, 0x00ec, 0x00ee, 0x00ef, 0x00f1, 0x00f3,
  0x00f2, 0x00f4, 0x00f6, 0x00f5, 0x00fa, 0x00f9, 0x00fb, 0x00fc, 0x2020, 0x00b0, 0x00a2, 0x00a3,
  0x00a7, 0x2022, 0x00b6, 0x00df, 0x00ae, 0x00a9, 0x2122, 0x00b4, 0x00a8, 0x2260, 0x00c6, 0x00d8,
  0x221e, 0x00b1, 0x2264, 0x2265, 0x00a5, 0x00b5, 0x2202, 0x2211, 0x220f, 0x03c0, 0x222b, 0x00aa,
  0x00ba, 0x03a9, 0x00e6, 0x00f8, 0x00bf, 0x00a1, 0x00ac, 0x221a, 0x0192, 0x2248, 0x2206, 0x00ab,
  0x00bb, 0x2026, 0x00a0, 0x00c0, 0x00c3, 0x00d5, 0x0152, 0x0153, 0x2013, 0x2014, 0x201c, 0x201d,
  0x2018, 0x2019, 0x00f7, 0x25ca, 0x00ff, 0x0178, 0x2044, 0x20ac, 0x2039, 0x203a, 0xfb01, 0xfb02,
  0x2021, 0x00b7, 0x201a, 0x201e, 0x2030, 0x00c2, 0x00ca, 0x00c1, 0x00cb, 0x00c8, 0x00cd, 0x00ce,
  0x00cf, 0x00cc, 0x00d3, 0x00d4, 0xf8ff, 0x00d2, 0x00da, 0x00db, 0x00d9, 0x0131, 0x02c6, 0x02dc,
  0x00af, 0x02d8, 0x02d9, 0x02da, 0x00b8, 0x02dd, 0x02db, 0x02c7,
];

/**
 * Glyph names this extractor resolves without a /ToUnicode map.
 *
 * Deliberately small: the Latin letters and the punctuation a Polish programme document
 * actually uses, plus the `uniXXXX` and `gNN` conventions. An unlisted name is reported,
 * not guessed — a wrong glyph name would put a wrong character inside a verbatim quote.
 */
const GLYPH_NAMES: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24, percent: 0x25,
  ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28, parenright: 0x29, asterisk: 0x2a, plus: 0x2b,
  comma: 0x2c, hyphen: 0x2d, period: 0x2e, slash: 0x2f, zero: 0x30, one: 0x31, two: 0x32,
  three: 0x33, four: 0x34, five: 0x35, six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39,
  colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e, question: 0x3f, at: 0x40,
  bracketleft: 0x5b, backslash: 0x5c, bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f,
  grave: 0x60, braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  quoteleft: 0x2018, quoteright: 0x2019, quotedblleft: 0x201c, quotedblright: 0x201d,
  quotesinglbase: 0x201a, quotedblbase: 0x201e, endash: 0x2013, emdash: 0x2014, bullet: 0x2022,
  ellipsis: 0x2026, guillemotleft: 0x00ab, guillemotright: 0x00bb, nbspace: 0x00a0,
  Aogonek: 0x0104, aogonek: 0x0105, Cacute: 0x0106, cacute: 0x0107, Eogonek: 0x0118,
  eogonek: 0x0119, Lslash: 0x0141, lslash: 0x0142, Nacute: 0x0143, nacute: 0x0144,
  Oacute: 0x00d3, oacute: 0x00f3, Sacute: 0x015a, sacute: 0x015b, Zacute: 0x0179, zacute: 0x017a,
  Zdotaccent: 0x017b, zdotaccent: 0x017c, fi: 0xfb01, fl: 0xfb02, degree: 0x00b0, euro: 0x20ac,
  section: 0x00a7, paragraph: 0x00b6, periodcentered: 0x00b7, multiply: 0x00d7, minus: 0x2212,
  endash_alt: 0x2013,
};

function glyphNameToUnicode(name: string): number | null {
  if (name in GLYPH_NAMES) return GLYPH_NAMES[name];
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return parseInt(uni[1], 16);
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name);
  if (u) return parseInt(u[1], 16);
  if (/^[A-Za-z]$/.test(name)) return name.charCodeAt(0);
  return null;
}

/* ── Fonts ────────────────────────────────────────────────────────────────────── */

interface LoadedFont {
  bytesPerCode: 1 | 2;
  /** code → decoded string. A code absent here could not be decoded from the file. */
  toUnicode: Map<number, string>;
  widths: Map<number, number>;
  defaultWidth: number;
}

function parseToUnicodeCMap(source: string): Map<number, string> {
  const map = new Map<number, string>();
  const hex = (value: string): string => {
    const units: number[] = [];
    for (let index = 0; index + 3 < value.length + 1; index += 4) {
      const part = value.slice(index, index + 4);
      if (part.length < 4) break;
      units.push(parseInt(part, 16));
    }
    return units.length === 0 ? '' : String.fromCharCode(...units);
  };
  const charPattern = /beginbfchar([\s\S]*?)endbfchar/g;
  for (let block = charPattern.exec(source); block !== null; block = charPattern.exec(source)) {
    const pairs = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;
    for (let pair = pairs.exec(block[1]); pair !== null; pair = pairs.exec(block[1])) {
      map.set(parseInt(pair[1], 16), hex(pair[2]));
    }
  }
  const rangePattern = /beginbfrange([\s\S]*?)endbfrange/g;
  for (let block = rangePattern.exec(source); block !== null; block = rangePattern.exec(source)) {
    const body = block[1];
    const entry = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\[([\s\S]*?)\])/g;
    for (let match = entry.exec(body); match !== null; match = entry.exec(body)) {
      const low = parseInt(match[1], 16);
      const high = parseInt(match[2], 16);
      if (high < low || high - low > 65535) continue;
      if (match[3] !== undefined) {
        const base = hex(match[3]);
        for (let code = low; code <= high; code += 1) {
          if (base.length === 0) continue;
          const last = base.charCodeAt(base.length - 1) + (code - low);
          map.set(code, base.slice(0, -1) + String.fromCharCode(last & 0xffff));
        }
        continue;
      }
      const items = [...(match[4] ?? '').matchAll(/<([0-9A-Fa-f]*)>/g)];
      for (let index = 0; index < items.length && low + index <= high; index += 1) {
        map.set(low + index, hex(items[index][1]));
      }
    }
  }
  return map;
}

function loadFont(document: PdfDocument, fontValue: PdfValue): LoadedFont {
  const font = document.dict(fontValue);
  const loaded: LoadedFont = { bytesPerCode: 1, toUnicode: new Map(), widths: new Map(), defaultWidth: 500 };
  if (!font) return loaded;
  const subtype = document.resolve(font.get('Subtype'));
  const composite = isName(subtype) && subtype.name === 'Type0';
  if (composite) loaded.bytesPerCode = 2;

  const toUnicode = document.resolve(font.get('ToUnicode'));
  if (isStream(toUnicode)) {
    const data = document.streamData(toUnicode);
    if (data) for (const [code, text] of parseToUnicodeCMap(data.toString('latin1'))) loaded.toUnicode.set(code, text);
  }

  // Descendant fonts carry the widths of a composite font; a simple font carries its own.
  const descendants = document.resolve(font.get('DescendantFonts'));
  const descendant = Array.isArray(descendants) ? document.dict(descendants[0]) : null;
  const widthSource = descendant ?? font;
  const descriptor = document.dict(widthSource.get('FontDescriptor'));
  const missing = descriptor ? document.resolve(descriptor.get('MissingWidth')) : null;
  if (typeof missing === 'number') loaded.defaultWidth = missing;

  if (descendant) {
    const defaultWidth = document.resolve(descendant.get('DW'));
    if (typeof defaultWidth === 'number') loaded.defaultWidth = defaultWidth;
    const widths = document.resolve(descendant.get('W'));
    if (Array.isArray(widths)) {
      for (let index = 0; index < widths.length;) {
        const first = document.resolve(widths[index]);
        const second = document.resolve(widths[index + 1]);
        if (typeof first !== 'number') break;
        if (Array.isArray(second)) {
          second.forEach((width, offset) => {
            const value = document.resolve(width);
            if (typeof value === 'number') loaded.widths.set(first + offset, value);
          });
          index += 2;
          continue;
        }
        const third = document.resolve(widths[index + 2]);
        if (typeof second !== 'number' || typeof third !== 'number') break;
        for (let code = first; code <= second && code - first < 65536; code += 1) loaded.widths.set(code, third);
        index += 3;
      }
    }
  } else {
    const first = document.resolve(font.get('FirstChar'));
    const widths = document.resolve(font.get('Widths'));
    if (typeof first === 'number' && Array.isArray(widths)) {
      widths.forEach((width, offset) => {
        const value = document.resolve(width);
        if (typeof value === 'number') loaded.widths.set(first + offset, value);
      });
    }
  }

  if (loaded.toUnicode.size > 0 || composite) return loaded;

  // No /ToUnicode: fall back to the declared simple-font encoding.
  const encoding = document.resolve(font.get('Encoding'));
  let base = 'Standard';
  let differences: PdfValue[] = [];
  if (isName(encoding)) base = encoding.name;
  else if (isDict(encoding)) {
    const baseName = document.resolve(encoding.get('BaseEncoding'));
    if (isName(baseName)) base = baseName.name;
    const list = document.resolve(encoding.get('Differences'));
    if (Array.isArray(list)) differences = list;
  }
  const high = base === 'MacRomanEncoding' ? MAC_ROMAN_HIGH : WIN_ANSI_HIGH;
  for (let code = 32; code < 127; code += 1) loaded.toUnicode.set(code, String.fromCharCode(code));
  for (let code = 128; code < 256; code += 1) {
    const point = high[code - 128];
    if (point !== undefined && point >= 32) loaded.toUnicode.set(code, String.fromCodePoint(point));
  }
  let current = 0;
  for (const item of differences) {
    const resolved = document.resolve(item);
    if (typeof resolved === 'number') { current = resolved; continue; }
    if (!isName(resolved)) continue;
    const point = glyphNameToUnicode(resolved.name);
    if (point === null) loaded.toUnicode.delete(current);
    else loaded.toUnicode.set(current, String.fromCodePoint(point));
    current += 1;
  }
  return loaded;
}

/* ── Content stream interpretation ────────────────────────────────────────────── */

type Matrix = [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(left: Matrix, right: Matrix): Matrix {
  return [
    left[0] * right[0] + left[1] * right[2],
    left[0] * right[1] + left[1] * right[3],
    left[2] * right[0] + left[3] * right[2],
    left[2] * right[1] + left[3] * right[3],
    left[4] * right[0] + left[5] * right[2] + right[4],
    left[4] * right[1] + left[5] * right[3] + right[5],
  ];
}

interface Fragment { x: number; y: number; endX: number; size: number; text: string }

/**
 * Turn positioned fragments into lines.
 *
 * Reading order is stream order — correct for a linearly typeset document, which is what
 * the admission rules allow into the corpus. A fragment whose baseline differs from the
 * previous one starts a new line; a horizontal gap wide enough becomes a single space, which
 * is how a PDF that positions words separately still yields word boundaries.
 *
 * The gap multiplier (0.4 × font size) is set above the widest inter-letter gap a fully
 * justified line in this corpus's source is known to produce, not just above the average.
 * Justified text can stretch inter-character spacing, not only inter-word spacing, close to
 * (previously: past) a naive word-gap threshold on specific letter pairs — confirmed
 * (CORPUS-03) by instrumenting this function against the real 154-page programme PDF: every
 * genuine word gap in the whole document carries its own explicit space-glyph fragment
 * (so raising this multiplier cannot fuse two real words), while six single-letter-pair gaps
 * with no such space glyph — false positives from justification stretching alone, at ratios
 * 0.242–0.341 — were wrongly read as word boundaries at the previous 0.22 multiplier. The
 * widest gap correctly left unjoined anywhere in the document is at ratio 0.177, so 0.4 keeps
 * a wide margin on both sides.
 */
function assembleLines(fragments: Fragment[]): string {
  const lines: string[] = [];
  let current = '';
  let previous: Fragment | null = null;
  for (const fragment of fragments) {
    if (fragment.text === '') continue;
    if (previous !== null) {
      const sameLine = Math.abs(fragment.y - previous.y) <= Math.max(0.6, previous.size * 0.28);
      if (!sameLine) {
        lines.push(current);
        current = '';
      } else {
        const gap = fragment.x - previous.endX;
        if (gap > Math.max(0.8, previous.size * 0.4) && !current.endsWith(' ') && !fragment.text.startsWith(' ')) {
          current += ' ';
        }
      }
    }
    current += fragment.text;
    previous = fragment;
  }
  if (current !== '') lines.push(current);
  return lines.map((line) => line.replace(/[ \t]+$/g, '')).filter((line) => line.trim() !== '').join('\n');
}

function extractPage(document: PdfDocument, page: PdfDict, warnings: Set<string>): PdfPageText {
  const resources = document.dict(page.get('Resources')) ?? new Map();
  const fontResources = document.dict(resources.get('Font')) ?? new Map();
  const fonts = new Map<string, LoadedFont>();
  const fontFor = (name: string): LoadedFont => {
    const cached = fonts.get(name);
    if (cached) return cached;
    const loaded = loadFont(document, fontResources.get(name) ?? null);
    fonts.set(name, loaded);
    return loaded;
  };

  const contents = document.resolve(page.get('Contents'));
  const streams = Array.isArray(contents) ? contents : [contents];
  const parts: Buffer[] = [];
  for (const entry of streams) {
    const resolved = document.resolve(entry);
    if (!isStream(resolved)) continue;
    const data = document.streamData(resolved);
    if (data === null) { warnings.add('A content stream used an unsupported filter and was skipped.'); continue; }
    parts.push(data, Buffer.from('\n'));
  }
  const xobjects = document.dict(resources.get('XObject'));
  if (xobjects) {
    for (const [, value] of xobjects) {
      const stream = document.resolve(value);
      if (!isStream(stream)) continue;
      const subtype = document.resolve(stream.dict.get('Subtype'));
      if (isName(subtype) && subtype.name === 'Form') {
        warnings.add('A form XObject was not traversed; text inside it is not indexed.');
      }
    }
  }

  const body = Buffer.concat(parts);
  const lexer = new PdfLexer(body, 0);
  const operands: PdfValue[] = [];
  const fragments: Fragment[] = [];
  let undecoded = 0;

  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let textMatrix: Matrix = IDENTITY;
  let lineMatrix: Matrix = IDENTITY;
  let font: LoadedFont | null = null;
  let fontSize = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizontalScale = 1;
  let leading = 0;
  let rise = 0;

  const number = (value: PdfValue | undefined): number => (typeof value === 'number' ? value : 0);

  const show = (raw: string): void => {
    if (!font) return;
    const bytes = Buffer.from(raw, 'latin1');
    const step = font.bytesPerCode;
    for (let index = 0; index + step <= bytes.length; index += step) {
      const code = step === 1 ? bytes[index] : (bytes[index] << 8) | bytes[index + 1];
      let text = font.toUnicode.get(code);
      if (text === undefined) { text = '�'; undecoded += 1; }
      const width = (font.widths.get(code) ?? font.defaultWidth) / 1000;
      const advance = (width * fontSize + charSpacing + (code === 32 && step === 1 ? wordSpacing : 0)) * horizontalScale;
      const render = multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], multiply(textMatrix, ctm));
      const scale = Math.hypot(render[2], render[3]) || 1;
      const startX = render[4];
      const startY = render[5];
      textMatrix = multiply([1, 0, 0, 1, advance, 0], textMatrix);
      const after = multiply([fontSize * horizontalScale, 0, 0, fontSize, 0, rise], multiply(textMatrix, ctm));
      if (text !== '') fragments.push({ x: startX, y: startY, endX: after[4], size: scale, text });
    }
  };

  const nextLine = (tx: number, ty: number): void => {
    lineMatrix = multiply([1, 0, 0, 1, tx, ty], lineMatrix);
    textMatrix = lineMatrix;
  };

  while (!lexer.atEnd()) {
    lexer.skipSpace();
    if (lexer.atEnd()) break;
    const byte = body[lexer.position];
    if (byte === 0x2f || byte === 0x28 || byte === 0x5b || byte === 0x3c
      || (byte >= 0x30 && byte <= 0x39) || byte === 0x2b || byte === 0x2d || byte === 0x2e) {
      try { operands.push(lexer.parseValue()); } catch { lexer.position += 1; operands.length = 0; }
      if (operands.length > 64) operands.splice(0, operands.length - 64);
      continue;
    }
    const operator = lexer.readKeyword();
    switch (operator) {
      case 'q': stack.push(ctm); break;
      case 'Q': ctm = stack.pop() ?? ctm; break;
      case 'cm': ctm = multiply([
        number(operands[0]), number(operands[1]), number(operands[2]),
        number(operands[3]), number(operands[4]), number(operands[5]),
      ], ctm); break;
      case 'BT': textMatrix = IDENTITY; lineMatrix = IDENTITY; break;
      case 'ET': break;
      case 'Tf': {
        const name = operands[operands.length - 2];
        fontSize = number(operands[operands.length - 1]);
        font = isName(name) ? fontFor(name.name) : font;
        break;
      }
      case 'Td': nextLine(number(operands[0]), number(operands[1])); break;
      case 'TD': leading = -number(operands[1]); nextLine(number(operands[0]), number(operands[1])); break;
      case 'Tm': lineMatrix = [
        number(operands[0]), number(operands[1]), number(operands[2]),
        number(operands[3]), number(operands[4]), number(operands[5]),
      ]; textMatrix = lineMatrix; break;
      case 'T*': nextLine(0, -leading); break;
      case 'TL': leading = number(operands[0]); break;
      case 'Tc': charSpacing = number(operands[0]); break;
      case 'Tw': wordSpacing = number(operands[0]); break;
      case 'Tz': horizontalScale = number(operands[0]) / 100; break;
      case 'Ts': rise = number(operands[0]); break;
      case 'Tj': if (typeof operands[operands.length - 1] === 'string') show(operands[operands.length - 1] as string); break;
      case "'":
        nextLine(0, -leading);
        if (typeof operands[operands.length - 1] === 'string') show(operands[operands.length - 1] as string);
        break;
      case '"':
        wordSpacing = number(operands[operands.length - 3]);
        charSpacing = number(operands[operands.length - 2]);
        nextLine(0, -leading);
        if (typeof operands[operands.length - 1] === 'string') show(operands[operands.length - 1] as string);
        break;
      case 'TJ': {
        const array = operands[operands.length - 1];
        if (Array.isArray(array)) {
          for (const item of array) {
            if (typeof item === 'string') { show(item); continue; }
            if (typeof item === 'number') {
              const shift = (-item / 1000) * fontSize * horizontalScale;
              textMatrix = multiply([1, 0, 0, 1, shift, 0], textMatrix);
            }
          }
        }
        break;
      }
      default: break;
    }
    operands.length = 0;
  }

  return { pdfPage: 0, text: assembleLines(fragments), undecodedCount: undecoded };
}

/** Extract the text of every page, in physical page order. */
export function extractPdfText(bytes: Buffer): PdfExtraction {
  const document = new PdfDocument(bytes);
  const warnings = new Set<string>(document.warnings);
  const pages = document.pages();
  const out: PdfPageText[] = [];
  pages.forEach((page, index) => {
    const extracted = extractPage(document, page, warnings);
    out.push({ ...extracted, pdfPage: index + 1 });
  });
  return { pages: out, pageCount: out.length, warnings: [...warnings].sort() };
}

/** Tool identity recorded in every ingestion record, so an index states how it was produced. */
export const EXTRACTION_TOOL = 'szronox-pdf-text@1';
