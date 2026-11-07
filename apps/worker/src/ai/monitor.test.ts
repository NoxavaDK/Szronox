import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

import {
  claimNextMonitor, emptyMonitorSynthesis, filterMonitorSynthesis, synthesizeMonitor, tickMonitor,
  type MonitorPostInput,
} from './monitor.js';
import type { GeminiResponse } from './provider.js';

const sourcePost: MonitorPostInput = {
  url: 'https://x.com/konto/status/123', sourceName: 'Konto', groupLabel: 'Konfederacja',
  platform: 'x', author: 'Konto', publishedAt: null, text: 'To  jest\ncytat z posta.',
};

function response(value = emptyMonitorSynthesis()): GeminiResponse {
  return { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(value) }] } }] };
}

class StubPool {
  calls: Array<{ sql: string; values?: unknown[] }> = [];
  claimed = false;
  emptyPosts = false;
  finalized = false;
  failed: unknown[] | null = null;

  async query<Row extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
    this.calls.push({ sql, values });
    if (sql.includes("set state='failed'")) return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] } as QueryResult<Row>;
    if (sql.includes('with chosen as')) {
      if (!this.claimed) { this.claimed = true; return { rows: [{ id: 'report-1', report_date: '2026-11-06', model: 'stub-model', prompt_id: 'monitor-provisional-v1', lease_token: 'fence-1', attempt_count: 1 }], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as unknown as QueryResult<Row>; }
      return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] } as QueryResult<Row>;
    }
    if (sql.includes('from app.monitor_posts')) {
      if (this.emptyPosts) return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<Row>;
      return { rows: [{ url: sourcePost.url, source_name: 'Konto', group_label: 'Konfederacja', platform: 'x', author: 'Konto', published_at: null, text: sourcePost.text }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<Row>;
    }
    if (sql.includes('set state=$3')) { this.failed = values ?? []; return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] } as QueryResult<Row>; }
    return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] } as QueryResult<Row>;
  }

  async connect(): Promise<PoolClient> {
    const pool = this;
    return {
      query: async (sql: string, values?: unknown[]) => {
        pool.calls.push({ sql, values });
        if (sql.startsWith('select state,lease_token')) {
          return { rows: [{ state: 'running', lease_token: 'fence-1' }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] };
        }
        if (sql.startsWith("update app.monitor_reports set state='succeeded'")) {
          pool.finalized = true;
          return { rows: [], rowCount: 1, command: 'UPDATE', oid: 0, fields: [] };
        }
        return { rows: [], rowCount: 0, command: 'UPDATE', oid: 0, fields: [] };
      },
      release: () => undefined,
      connection: {} as never,
      on: () => undefined,
      once: () => undefined,
      removeListener: () => undefined,
      listenerCount: () => 0,
      off: () => undefined,
      emit: () => false,
      addListener: () => undefined,
      removeAllListeners: () => undefined,
      setMaxListeners: () => undefined,
      getMaxListeners: () => 0,
      prependListener: () => undefined,
      prependOnceListener: () => undefined,
      rawListeners: () => [],
      listeners: () => [],
      eventNames: () => [],
    } as unknown as PoolClient;
  }
}

test('synthesis drops unknown URLs and keeps only exact whitespace-normalized quotes', () => {
  const result = filterMonitorSynthesis({
    ...emptyMonitorSynthesis(),
    mainTopics: [{ topic: 'Temat', summary: 'Opis', postUrls: [sourcePost.url, 'https://unknown.test/post'] }],
    notableQuotes: [
      { quote: 'To jest cytat z posta.', postUrl: sourcePost.url, label: 'opinion' },
      { quote: 'Zmyślony cytat.', postUrl: sourcePost.url, label: 'fact' },
      { quote: 'Cytat', postUrl: 'https://unknown.test/post', label: 'fact' },
    ],
  }, [sourcePost]);
  assert.deepEqual(result.mainTopics[0].postUrls, [sourcePost.url]);
  assert.deepEqual(result.notableQuotes, [{ quote: 'To  jest\ncytat z posta.', postUrl: sourcePost.url, label: 'opinion' }]);
});

test('provider stub receives batches of at most 35 and one lowercase-schema merge', async () => {
  const posts = Array.from({ length: 70 }, (_, index) => ({ ...sourcePost, url: `https://x.com/konto/status/${index + 1}` }));
  const seen: Record<string, unknown>[] = [];
  const result = await synthesizeMonitor(posts, 'stub-model', async (_model, request) => { seen.push(request); return response(); });
  assert.equal(seen.length, 3);
  for (const call of seen) {
    const schema = call.generationConfig as { responseJsonSchema: { type: string; properties: Record<string, { type: string }> } };
    assert.equal(schema.responseJsonSchema.type, 'object');
    assert.equal(schema.responseJsonSchema.properties.mainTopics.type, 'array');
    const prompt = (((call.contents as Array<{ parts: Array<{ text: string }> }>)[0]).parts[0]).text;
    assert.match(prompt, /development_provisional/);
  }
  assert.deepEqual(result, emptyMonitorSynthesis());
});

test('worker stub writes a synthesis under the claimed lease token', async () => {
  const stub = new StubPool();
  const wrote = await tickMonitor(stub as unknown as Pool, {}, async () => response({
    ...emptyMonitorSynthesis(), notableQuotes: [{ quote: 'To jest cytat z posta.', postUrl: sourcePost.url, label: 'opinion' }],
  }));
  assert.equal(wrote, true);
  assert.equal(stub.finalized, true);
  const final = stub.calls.find((call) => call.sql.includes("set state='succeeded'"));
  assert.equal(final?.values?.[2], 'fence-1');
});

test('a zero-post day succeeds with an empty synthesis without a Gemini key', async () => {
  const stub = new StubPool();
  stub.emptyPosts = true;
  const wrote = await tickMonitor(stub as unknown as Pool, {});
  assert.equal(wrote, true);
  assert.equal(stub.finalized, true);
  assert.equal(stub.failed, null);
  const final = stub.calls.find((call) => call.sql.includes("set state='succeeded'"));
  assert.deepEqual(JSON.parse(String(final?.values?.[1])), emptyMonitorSynthesis());
});

test('retry is queued and expired final attempts are terminal', async () => {
  const retry = new StubPool();
  await tickMonitor(retry as unknown as Pool, {}, async () => { throw new Error('stub network fault'); });
  assert.equal(retry.failed?.[2], 'queued');
  const retrySql = retry.calls.find((call) => call.sql.includes('set state=$3'))?.sql ?? '';
  assert.match(retrySql, /where id=\$1 and state='running' and lease_token=\$2/);
  assert.equal(retry.failed?.[4] && JSON.parse(String(retry.failed[4])).retryable, true);

  const expired = new StubPool();
  expired.claimed = true;
  await claimNextMonitor(expired as unknown as Pool);
  const expiry = expired.calls.find((call) => call.sql.includes("set state='failed'"));
  assert.match(expiry?.sql ?? '', /lease_expires_at<now\(\) and attempt_count >= \$2/);
  assert.equal(expiry?.values?.[1], 5);
});
