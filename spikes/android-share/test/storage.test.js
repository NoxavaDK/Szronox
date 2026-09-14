import test from "node:test";
import assert from "node:assert/strict";
import { getRecord, promoteRaw, putRecord } from "../storage.js";

function controlledDb(records = new Map()) {
  const transactions = [];
  return {
    records,
    transactions,
    transaction(_store, mode) {
      if (!mode) {
        return { objectStore: () => ({ get(id) {
          const request = {};
          queueMicrotask(() => { request.result = records.get(id); request.onsuccess?.(); });
          return request;
        } }) };
      }
      const pending = [];
      const transaction = {
        error: null,
        objectStore: () => ({
          get(id) {
            const request = {};
            queueMicrotask(() => { request.result = records.get(id); request.onsuccess?.(); });
            return request;
          },
          put(record) { pending.push(record); return {}; }
        }),
        complete() { for (const record of pending) records.set(record.id, structuredClone(record)); transaction.oncomplete?.(); },
        abort() { transaction.error = new Error("quota"); transaction.onabort?.(); }
      };
      transactions.push(transaction);
      return transaction;
    }
  };
}

test("put resolves only after transaction completion", async () => {
  const db = controlledDb();
  let resolved = false;
  const write = putRecord(db, { id:"capture-1", value:"raw" }).then(() => { resolved = true; });
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(db.records.has("capture-1"), false);
  db.transactions[0].complete();
  await write;
  assert.equal(resolved, true);
});

test("aborted write rejects and leaves no false persisted record", async () => {
  const db = controlledDb();
  const write = putRecord(db, { id:"capture-1" });
  db.transactions[0].abort();
  await assert.rejects(write, /quota/);
  assert.equal(db.records.has("capture-1"), false);
});

test("promotion overwrites the raw key and survives reopen with stable IDs", async () => {
  const records = new Map([["capture-1", { id:"capture-1", recordType:"raw-share", operationId:"operation-1" }]]);
  const db = controlledDb(records);
  const draft = { id:"capture-1", operationId:"operation-1", state:"quarantined_pending_identity" };
  const write = promoteRaw(db, "capture-1", draft);
  await Promise.resolve();
  db.transactions[0].complete();
  await write;
  const reopenedDb = controlledDb(records);
  const reopened = await getRecord(reopenedDb, "capture-1");
  assert.equal(reopened.recordType, "capture-draft");
  assert.equal(reopened.id, "capture-1");
  assert.equal(reopened.operationId, "operation-1");
  assert.equal(records.size, 1);
});

test("a second promotion returns the committed draft instead of overwriting it", async () => {
  const committed = { id:"capture-1", operationId:"operation-1", recordType:"capture-draft", accountId:"account-A" };
  const db = controlledDb(new Map([["capture-1", committed]]));
  const stale = { id:"capture-1", operationId:"operation-1", accountId:null };
  const write = promoteRaw(db, "capture-1", stale);
  await Promise.resolve();
  db.transactions[0].complete();
  assert.deepEqual(await write, committed);
  assert.deepEqual(db.records.get("capture-1"), committed);
});

test("promotion refuses an identity change", () => {
  assert.throws(() => promoteRaw(controlledDb(), "raw-1", { id:"new-1" }), /CAPTURE_ID_CHANGED/);
});
