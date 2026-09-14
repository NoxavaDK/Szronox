import { DB_NAME, STORE_NAME } from "./share-contract.js";

export function openShareDb(indexedDb = indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDb.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function getRecord(db, id) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export function putRecord(db, record) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);
    transaction.oncomplete = () => resolve(record);
    transaction.onabort = () => reject(transaction.error || new Error("INDEXEDDB_ABORTED"));
    transaction.onerror = () => reject(transaction.error || new Error("INDEXEDDB_FAILED"));
  });
}

export function promoteRaw(db, rawId, draft) {
  if (draft.id !== rawId) throw new Error("CAPTURE_ID_CHANGED");
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(rawId);
    let result;
    request.onsuccess = () => {
      if (request.result?.recordType === "capture-draft") result = request.result;
      else {
        result = { ...draft, recordType: "capture-draft" };
        store.put(result);
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error || new Error("INDEXEDDB_ABORTED"));
    transaction.onerror = () => reject(transaction.error || new Error("INDEXEDDB_FAILED"));
  });
}
