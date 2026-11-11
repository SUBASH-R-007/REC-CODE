/**
 * A deliberately small IndexedDB wrapper for drafts (no dependency): one
 * database, one object store, out-of-line string keys, get / put / delete.
 *
 * IndexedDB can be missing (SSR, very old browsers), refuse to open (some
 * private modes, blocked site data, a full disk) or be closed under us (a
 * newer tab upgrading the schema). Every call therefore resolves — never
 * rejects — and reports failure as data, so the editor keeps working and
 * the server copy still saves.
 */

const DB_NAME = "recx";
const DB_VERSION = 1;
const STORE = "drafts";
const OPEN_TIMEOUT_MS = 3_000;

let opening: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  const attempt = new Promise<IDBDatabase | null>((resolve) => {
    let settled = false;
    const settle = (db: IDBDatabase | null) => {
      if (settled) {
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(db);
    };
    const timer = setTimeout(() => settle(null), OPEN_TIMEOUT_MS);
    let request: IDBOpenDBRequest;
    try {
      if (typeof indexedDB === "undefined") return settle(null);
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return settle(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab is upgrading: step aside and reopen on the next call.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      settle(db);
    };
    request.onerror = () => settle(null);
    request.onblocked = () => settle(null);
  });
  opening = attempt;
  // A failed open is retried on the next call rather than cached forever.
  void attempt.then((db) => {
    if (!db && opening === attempt) opening = null;
  });
  return attempt;
}

function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  return openDb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve({ ok: false });
        try {
          const tx = db.transaction(STORE, mode);
          const request = body(tx.objectStore(STORE));
          // A get of a missing key resolves `undefined`, which is a valid answer.
          let value = undefined as T;
          request.onsuccess = () => {
            value = request.result;
          };
          tx.oncomplete = () => resolve({ ok: true, value });
          tx.onerror = () => resolve({ ok: false });
          tx.onabort = () => resolve({ ok: false });
        } catch {
          // InvalidStateError (closing database) and friends.
          opening = null;
          resolve({ ok: false });
        }
      }),
  );
}

/** Read a raw value. `{ok:false}` when IndexedDB is unavailable. */
export function idbGet(key: string): Promise<{ ok: true; value: unknown } | { ok: false }> {
  return run<unknown>("readonly", (store) => store.get(key));
}

/** Write a value; resolves true once the transaction has committed. */
export async function idbPut(key: string, value: unknown): Promise<boolean> {
  return (await run<IDBValidKey>("readwrite", (store) => store.put(value, key))).ok;
}

export async function idbDelete(key: string): Promise<boolean> {
  return (await run<undefined>("readwrite", (store) => store.delete(key))).ok;
}
