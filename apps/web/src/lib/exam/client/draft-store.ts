"use client";

/**
 * The write-ahead store (Phase 6c).
 *
 * SPEC §5: "Write-ahead to IndexedDB BEFORE every network call."
 *
 * That ordering is the whole design. If the network call goes first and
 * fails, the candidate's last edit exists only in a React state tree that a
 * reload destroys. Writing locally first means the worst case is "your work
 * is safe but not yet on the server", which is a sentence the save-state pill
 * can honestly say — and is why that pill has an "Offline — retrying" state
 * rather than a spinner that lies.
 *
 * Everything here fails soft. A browser in private mode, with site data
 * blocked, or out of quota will reject the open; the exam must still work,
 * because the server is the authority and this is a safety net. So every
 * method resolves rather than throwing, and `available()` reports whether
 * the net is actually there so the UI can tell the truth about it.
 */

const DB_NAME = "recx-exam";
const DB_VERSION = 1;
const STORE = "drafts";

export interface StoredDraft {
  /** `${attemptId}:${questionId}` */
  readonly key: string;
  readonly attemptId: string;
  readonly questionId: string;
  readonly language: string;
  readonly source: string;
  /** Local wall-clock of the write. Advisory only; the server owns time. */
  readonly savedAtMs: number;
  /** False until the server has acknowledged this exact text. */
  readonly synced: boolean;
}

function keyOf(attemptId: string, questionId: string): string {
  return `${attemptId}:${questionId}`;
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Site data blocked. The exam still works; the pill will say so.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab holds an older version open. Not worth blocking the exam.
    request.onblocked = () => resolve(null);
  });
  return opening;
}

function run<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return open().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        let request: IDBRequest<T>;
        try {
          request = work(db.transaction(STORE, mode).objectStore(STORE));
        } catch {
          resolve(null);
          return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
      }),
  );
}

/** Is the net actually there? The UI needs to know before it promises anything. */
export async function available(): Promise<boolean> {
  return (await open()) !== null;
}

/**
 * Write ahead. Called BEFORE the network, on every edit worth saving, so the
 * text on screen is never the only copy.
 */
export async function putDraft(draft: Omit<StoredDraft, "key">): Promise<void> {
  await run("readwrite", (store) =>
    store.put({ ...draft, key: keyOf(draft.attemptId, draft.questionId) } satisfies StoredDraft),
  );
}

/** Mark a draft acknowledged, so a reload knows what the server already has. */
export async function markSynced(attemptId: string, questionId: string, source: string): Promise<void> {
  const key = keyOf(attemptId, questionId);
  const existing = (await run<StoredDraft>("readonly", (store) => store.get(key))) ?? null;
  // Only if the text is still the text that was sent: an edit that landed
  // while the request was in flight must not be marked as saved.
  if (!existing || existing.source !== source) return;
  await run("readwrite", (store) => store.put({ ...existing, synced: true }));
}

export async function getDraft(attemptId: string, questionId: string): Promise<StoredDraft | null> {
  return (await run<StoredDraft>("readonly", (store) => store.get(keyOf(attemptId, questionId)))) ?? null;
}

/**
 * Every draft of one attempt, for the "your work was recovered" path after a
 * crash or a closed laptop.
 */
export async function draftsForAttempt(attemptId: string): Promise<StoredDraft[]> {
  const all = (await run<StoredDraft[]>("readonly", (store) => store.getAll())) ?? [];
  return all.filter((draft) => draft.attemptId === attemptId);
}

/**
 * Drop an attempt's drafts once it is finished and submitted.
 *
 * Lab machines are shared, which is the reason this exists: the next
 * candidate at that seat must not find the previous one's code in their
 * browser's storage.
 */
export async function clearAttempt(attemptId: string): Promise<void> {
  const drafts = await draftsForAttempt(attemptId);
  for (const draft of drafts) await run("readwrite", (store) => store.delete(draft.key));
}
