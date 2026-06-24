/* ═══════════════════════════════════════════════════════════════════════════
   db.js — PharmaScan KE  ·  IndexedDB layer
   Stores: history, image cache (pHash → analysis), offline queue, usage stats
   All data lives 100% on-device — nothing leaves except the OpenAI call.
   ═══════════════════════════════════════════════════════════════════════════ */

const DB_NAME    = "pharmascan";
const DB_VERSION = 2;

// ─── Object store names ─────────────────────────────────────────────────────
const STORE_HISTORY = "history";   // scan results log
const STORE_CACHE   = "cache";     // pHash → analysis text
const STORE_QUEUE   = "queue";     // offline retry queue
const STORE_USAGE   = "usage";     // monthly token / cost tracker

// ─── Open DB ────────────────────────────────────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const db = e.target.result;

      // History store
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const hist = db.createObjectStore(STORE_HISTORY, { keyPath: "id", autoIncrement: true });
        hist.createIndex("createdAt", "createdAt");
        hist.createIndex("mode",      "mode");
        hist.createIndex("tag",       "tag");
      }

      // Cache store (keyed by pHash string)
      if (!db.objectStoreNames.contains(STORE_CACHE)) {
        const cache = db.createObjectStore(STORE_CACHE, { keyPath: "hash" });
        cache.createIndex("usedAt", "usedAt");
      }

      // Offline queue
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id", autoIncrement: true });
      }

      // Usage stats — one record per "YYYY-MM" month
      if (!db.objectStoreNames.contains(STORE_USAGE)) {
        db.createObjectStore(STORE_USAGE, { keyPath: "month" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ─── Generic helpers ─────────────────────────────────────────────────────────
function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const result = fn(transaction);
    transaction.oncomplete = () => resolve(result instanceof Promise ? result : result);
    transaction.onerror    = () => reject(transaction.error);
    transaction.onabort    = () => reject(new Error("Transaction aborted"));
  });
}

function promReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HISTORY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Save a completed scan to history.
 * @param {object} entry { thumbnailDataUri, analysisText, mode, tier, provider, model, inputTokens, outputTokens, userNote, tag? }
 * @returns {number} the new record id
 */
export async function historySave(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_HISTORY, "readwrite");
    const store = transaction.objectStore(STORE_HISTORY);
    const record = {
      ...entry,
      createdAt: Date.now(),
      tag: entry.tag || "",
    };
    const req = store.add(record);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Retrieve all history records, newest first.
 * @param {number} limit  Max records to return (default 100)
 * @param {string} mode   Filter by mode (optional)
 * @returns {object[]}
 */
export async function historyGetAll({ limit = 100, mode = null } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_HISTORY, "readonly");
    const store = transaction.objectStore(STORE_HISTORY);
    const index = store.index("createdAt");
    const results = [];
    // Cursor in descending order
    const req = index.openCursor(null, "prev");
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      const r = cursor.value;
      if (!mode || r.mode === mode) results.push(r);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Delete a single history record.
 */
export async function historyDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_HISTORY, "readwrite");
    const req = transaction.objectStore(STORE_HISTORY).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Clear all history.
 */
export async function historyClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_HISTORY, "readwrite");
    const req = transaction.objectStore(STORE_HISTORY).clear();
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Update tag on a history record.
 */
export async function historySetTag(id, tag) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_HISTORY, "readwrite");
    const store = transaction.objectStore(STORE_HISTORY);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result;
      if (!record) return reject(new Error("Record not found"));
      record.tag = tag;
      const putReq = store.put(record);
      putReq.onsuccess = () => resolve();
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PERCEPTUAL HASH CACHE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a simple 64-bit perceptual hash from a canvas blob.
 * Uses 8×8 average-hash (aHash) — fast and good enough for document pages.
 * @param {Blob} blob  JPEG/PNG image blob
 * @returns {string}   hex hash string
 */
export function computePHash(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const SIZE = 8;
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      // Convert to greyscale via willReadFrequently
      ctx.filter = "grayscale(1)";
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
      // Compute average of R channel (greyscale R≈G≈B)
      let sum = 0;
      const pixels = [];
      for (let i = 0; i < data.length; i += 4) {
        pixels.push(data[i]);
        sum += data[i];
      }
      const avg = sum / pixels.length;
      // Build binary hash → hex
      let bits = "";
      for (const p of pixels) bits += p >= avg ? "1" : "0";
      let hex = "";
      for (let i = 0; i < bits.length; i += 4) {
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
      }
      resolve(hex);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(""); };
    img.src = url;
  });
}

/**
 * Look up a cached analysis by pHash.
 * Updates usedAt on hit so LRU eviction works.
 * @returns {string|null} analysisText or null if not cached
 */
export async function cacheGet(hash) {
  if (!hash) return null;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_CACHE, "readwrite");
    const store = transaction.objectStore(STORE_CACHE);
    const req = store.get(hash);
    req.onsuccess = () => {
      const record = req.result;
      if (!record) return resolve(null);
      // Update LRU timestamp
      record.usedAt = Date.now();
      store.put(record);
      resolve(record.analysisText);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store an analysis result in the cache.
 * Also evicts oldest entries if cache exceeds 200 items.
 */
export async function cachePut(hash, analysisText, thumbnailDataUri) {
  if (!hash) return;
  const db = await openDB();
  await new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_CACHE, "readwrite");
    const store = transaction.objectStore(STORE_CACHE);
    const record = { hash, analysisText, thumbnailDataUri, usedAt: Date.now() };
    const req = store.put(record);
    req.onsuccess = resolve;
    req.onerror   = () => reject(req.error);
  });
  // Evict oldest beyond 200
  await cacheEvict(db, 200);
}

async function cacheEvict(db, maxItems) {
  return new Promise((resolve) => {
    const transaction = db.transaction(STORE_CACHE, "readwrite");
    const store = transaction.objectStore(STORE_CACHE);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const count = countReq.result;
      if (count <= maxItems) return resolve();
      const toDelete = count - maxItems;
      const index = store.index("usedAt");
      let deleted = 0;
      const cursor = index.openCursor(null, "next"); // oldest first
      cursor.onsuccess = (e) => {
        const c = e.target.result;
        if (!c || deleted >= toDelete) return resolve();
        c.delete();
        deleted++;
        c.continue();
      };
    };
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// OFFLINE QUEUE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Enqueue a failed request for retry when back online.
 * @param {object} item { images, mode, tier, userNote }
 */
export async function queueAdd(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_QUEUE, "readwrite");
    const req = transaction.objectStore(STORE_QUEUE).add({
      ...item,
      queuedAt: Date.now(),
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function queueGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_QUEUE, "readonly").objectStore(STORE_QUEUE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

export async function queueDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_QUEUE, "readwrite").objectStore(STORE_QUEUE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// USAGE STATS
// ═══════════════════════════════════════════════════════════════════════════

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// Rough cost constants (USD per 1M tokens, as of 2025)
const COST_PER_M = {
  "gpt-4o":              { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":         { input: 0.15,  output: 0.60  },
  "claude-3-haiku-20240307": { input: 0.25,  output: 1.25  },
};

/**
 * Record token usage after a successful scan.
 */
export async function usageRecord({ model, inputTokens, outputTokens }) {
  const month  = currentMonth();
  const rates  = COST_PER_M[model] || { input: 2.50, output: 10.00 };
  const cost   = (inputTokens / 1_000_000) * rates.input
               + (outputTokens / 1_000_000) * rates.output;

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_USAGE, "readwrite");
    const store = transaction.objectStore(STORE_USAGE);
    const getReq = store.get(month);
    getReq.onsuccess = () => {
      const existing = getReq.result || { month, scans: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      existing.scans        += 1;
      existing.inputTokens  += inputTokens;
      existing.outputTokens += outputTokens;
      existing.costUsd      += cost;
      const putReq = store.put(existing);
      putReq.onsuccess = () => resolve(existing);
      putReq.onerror   = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get usage stats for the current month.
 */
export async function usageGetMonth() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_USAGE, "readonly").objectStore(STORE_USAGE).get(currentMonth());
    req.onsuccess = () => resolve(req.result || { month: currentMonth(), scans: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    req.onerror   = () => reject(req.error);
  });
}

/**
 * Get all months of usage (for dashboard).
 */
export async function usageGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_USAGE, "readonly").objectStore(STORE_USAGE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.month.localeCompare(a.month)));
    req.onerror   = () => reject(req.error);
  });
}
