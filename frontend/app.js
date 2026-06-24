/* ═══════════════════════════════════════════════════════════════════════════
   app.js — PharmaScan KE v2  ·  Main orchestrator
   Wires: camera · multi-image · mode/tier · SSE streaming · IndexedDB
          history panel · usage dashboard · offline queue · pHash cache
   ═══════════════════════════════════════════════════════════════════════════ */

import {
  historySave, historyGetAll, historyDelete, historyClear, historySetTag,
  cacheGet, cachePut, computePHash,
  queueAdd, queueGetAll, queueDelete,
  usageRecord, usageGetMonth, usageGetAll,
} from "./db.js";

import {
  startCamera, stopCamera, isCameraActive,
  captureFrame, compressImage, measureBlur, isBlurry,
  makeThumbnail, blobToBase64, MAX_IMAGES,
} from "./camera.js";

// ─── DOM ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const cameraFeed       = $("cameraFeed");
const cameraWrapper    = $("cameraWrapper");
const captureBtn       = $("captureBtn");
const uploadFallback   = $("uploadFallback");
const fileInput        = $("fileInput");
const blurWarning      = $("blurWarning");
const imageStripWrapper = $("imageStripWrapper");
const imageStrip       = $("imageStrip");
const stripLabel       = $("stripLabel");
const clearStripBtn    = $("clearStripBtn");
const addMoreBtn       = $("addMoreBtn");
const modePills        = $("modePills");
const tierToggle       = $("tierToggle");
const userNoteEl       = $("userNote");
const analyzeBtn       = $("analyzeBtn");
const analyzeBtnCount  = $("analyzeBtnCount");
const statusBar        = $("statusBar");
const statusText       = $("statusText");
const cancelBtn        = $("cancelBtn");
const resultCard       = $("resultCard");
const resultBody       = $("resultBody");
const resultMeta       = $("resultMeta");
const copyBtn          = $("copyBtn");
const saveBtn          = $("saveBtn");
const clearBtn         = $("clearBtn");
const historyToggleBtn = $("historyToggleBtn");
const historyBadge     = $("historyBadge");
const historyPanel     = $("historyPanel");
const historyList      = $("historyList");
const historyCloseBtn  = $("historyCloseBtn");
const clearHistoryBtn  = $("clearHistoryBtn");
const panelOverlay     = $("panelOverlay");
const dashboardBtn     = $("dashboardBtn");
const dashboardOverlay = $("dashboardOverlay");
const dashboardBody    = $("dashboardBody");
const dashboardCloseBtn = $("dashboardCloseBtn");
const detailOverlay    = $("detailOverlay");
const detailThumbRow   = $("detailThumbRow");
const detailMeta       = $("detailMeta");
const detailBody       = $("detailBody");
const detailCloseBtn   = $("detailCloseBtn");
const detailCopyBtn    = $("detailCopyBtn");
const detailDeleteBtn  = $("detailDeleteBtn");
const pillGroq       = $("pillGroq");
const offlinePill      = $("offlinePill");
const toastEl          = $("toast");

// ─── App state ────────────────────────────────────────────────────────────────
const capturedImages = []; // Array of { blob, thumbnailDataUri, base64 }
let selectedMode     = "general";
let selectedTier     = "deep";
let abortCtrl        = null;
let isAnalyzing      = false;
let lastAnalysisText = "";
let lastAnalysisMeta = {};
let blurCheckInterval = null;
let currentDetailId  = null;

// ─── Toast ───────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, type = "") {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (type ? ` ${type}` : "");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
}

// ─── Provider status ─────────────────────────────────────────────────────────
async function refreshProviderStatus() {
  try {
    const res = await fetch("/api/models");
    if (!res.ok) return;
    const data = await res.json();
    pillGroq.dataset.active = String(data.groq);
    // Update tier sub-labels with actual model names
    document.querySelectorAll(".tier-btn[data-tier='quick'] .tier-sub")
      .forEach((el) => { el.textContent = `${data.models.quick} · cheap`; });
    document.querySelectorAll(".tier-btn[data-tier='deep'] .tier-sub")
      .forEach((el) => { el.textContent = `${data.models.deep} · thorough`; });
  } catch { /* offline */ }
}

// ─── Online / offline ────────────────────────────────────────────────────────
function updateOnlineStatus() {
  offlinePill.hidden = navigator.onLine;
  if (navigator.onLine) drainOfflineQueue();
}

window.addEventListener("online",  updateOnlineStatus);
window.addEventListener("offline", updateOnlineStatus);

async function drainOfflineQueue() {
  const items = await queueGetAll();
  if (!items.length) return;
  toast(`📶 Back online — retrying ${items.length} queued scan(s)…`);
  for (const item of items) {
    try {
      const text = await runAnalysis(item.images, item.mode, item.tier, item.userNote, true);
      if (text) await queueDelete(item.id);
    } catch { /* leave in queue */ }
  }
}

// ─── Camera start & blur detection ───────────────────────────────────────────
async function initCamera() {
  const ok = await startCamera(cameraFeed);
  if (!ok) {
    uploadFallback.hidden = false;
    captureBtn.hidden = true;
  } else {
    uploadFallback.hidden = true;
    captureBtn.hidden = false;
    startBlurCheck();
  }
}

function startBlurCheck() {
  if (blurCheckInterval) return;
  // Lightweight live blur check on a small canvas snapshot every 1.5s
  blurCheckInterval = setInterval(async () => {
    if (!isCameraActive() || isAnalyzing) return;
    try {
      const blob = await captureFrame(cameraFeed);
      const score = await measureBlur(blob);
      blurWarning.hidden = !isBlurry(score);
    } catch { /* ignore */ }
  }, 1500);
}

// ─── Capture ─────────────────────────────────────────────────────────────────
async function handleCapture() {
  if (!isCameraActive()) return;
  if (capturedImages.length >= MAX_IMAGES) {
    return toast(`Max ${MAX_IMAGES} pages per scan.`, "error");
  }
  captureBtn.disabled = true;
  try {
    const rawBlob  = await captureFrame(cameraFeed);
    const score    = await measureBlur(rawBlob);
    if (isBlurry(score)) {
      toast("⚠️ Blurry! Hold camera steady and try again.", "error");
      return;
    }
    const compressed  = await compressImage(rawBlob);
    const thumbnail   = await makeThumbnail(compressed);
    const b64         = await blobToBase64(compressed);
    capturedImages.push({ blob: compressed, thumbnailDataUri: thumbnail, base64: b64 });
    renderStrip();
    updateAnalyzeBtn();
    toast(`Page ${capturedImages.length} captured ✓`, "success");
  } catch (e) {
    toast("Capture failed: " + e.message, "error");
  } finally {
    captureBtn.disabled = false;
  }
}

// ─── File upload ─────────────────────────────────────────────────────────────
async function handleFileUpload(files) {
  const available = MAX_IMAGES - capturedImages.length;
  const toProcess = Array.from(files).slice(0, available);
  if (!toProcess.length) return toast(`Max ${MAX_IMAGES} images.`, "error");

  for (const file of toProcess) {
    try {
      const compressed = await compressImage(file);
      const thumbnail  = await makeThumbnail(compressed);
      const b64        = await blobToBase64(compressed);
      capturedImages.push({ blob: compressed, thumbnailDataUri: thumbnail, base64: b64 });
    } catch (e) {
      toast("Failed to load image: " + e.message, "error");
    }
  }
  renderStrip();
  updateAnalyzeBtn();
  if (capturedImages.length) toast(`${capturedImages.length} image(s) ready ✓`, "success");
}

// ─── Strip rendering ─────────────────────────────────────────────────────────
function renderStrip() {
  imageStrip.innerHTML = "";
  for (let i = 0; i < capturedImages.length; i++) {
    const { thumbnailDataUri } = capturedImages[i];
    const div = document.createElement("div");
    div.className = "strip-thumb";
    div.innerHTML = `
      <img src="${thumbnailDataUri}" alt="Page ${i+1}" />
      <span class="page-num">${i+1}</span>
      <button class="remove-btn" data-index="${i}" title="Remove">✕</button>
    `;
    imageStrip.appendChild(div);
  }
  imageStripWrapper.hidden = capturedImages.length === 0;
  stripLabel.textContent = `${capturedImages.length} page${capturedImages.length !== 1 ? "s" : ""} captured`;
}

function removeImage(index) {
  capturedImages.splice(index, 1);
  renderStrip();
  updateAnalyzeBtn();
}

function updateAnalyzeBtn() {
  const count = capturedImages.length;
  analyzeBtn.disabled = count === 0 || isAnalyzing;
  analyzeBtnCount.textContent = count > 0 ? `(${count})` : "";
}

// ─── Mode & tier selection ────────────────────────────────────────────────────
modePills.addEventListener("click", (e) => {
  const btn = e.target.closest(".mode-pill");
  if (!btn) return;
  selectedMode = btn.dataset.mode;
  modePills.querySelectorAll(".mode-pill").forEach((p) => p.classList.remove("active"));
  btn.classList.add("active");
});

tierToggle.addEventListener("click", (e) => {
  const btn = e.target.closest(".tier-btn");
  if (!btn) return;
  selectedTier = btn.dataset.tier;
  tierToggle.querySelectorAll(".tier-btn").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
});

// ─── Core analysis ────────────────────────────────────────────────────────────
/**
 * Run the analysis pipeline. Called by the Analyse button and offline drain.
 * @returns {string|null} the full analysis text on success, null on failure
 */
async function runAnalysis(images, mode, tier, userNote, isRetry = false) {
  // pHash cache check (single-image only — multi-page gets skipped)
  if (images.length === 1 && capturedImages[0]?.blob) {
    const hash = await computePHash(capturedImages[0].blob);
    const cached = await cacheGet(hash);
    if (cached) {
      renderResult(cached, { provider: "cache", fromCache: true });
      toast("⚡ Loaded from local cache", "success");
      return cached;
    }
  }

  abortCtrl = new AbortController();
  isAnalyzing = true;
  analyzeBtn.disabled = true;
  statusBar.hidden = false;
  statusText.textContent = "Connecting…";
  resultCard.hidden = false;
  resultBody.innerHTML = '<span class="cursor"></span>';
  resultMeta.innerHTML = "";
  lastAnalysisText = "";
  lastAnalysisMeta = {};

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ images, mode, tier, userNote }),
      signal: abortCtrl.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error || `Server error ${response.status}`);
    }

    const reader  = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw) continue;

        let data;
        try { data = JSON.parse(raw); } catch { continue; }

        if (data.status) {
          statusText.textContent = data.status;
        }
        if (data.error) {
          toast(data.error, "error");
          resultBody.innerHTML = `<p style="color:var(--danger)">⚠️ ${data.error}</p>`;
          cleanup();
          return null;
        }
        if (data.text) {
          fullText += data.text;
          // Render markdown + live cursor
          resultBody.innerHTML = marked.parse(fullText) + '<span class="cursor"></span>';
          resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
        if (data.done) {
          // Remove cursor, set final state
          resultBody.innerHTML = marked.parse(fullText);
          lastAnalysisText = fullText;
          lastAnalysisMeta = {
            provider:     data.provider    || "openai",
            model:        data.model       || "",
            inputTokens:  data.inputTokens || 0,
            outputTokens: data.outputTokens|| 0,
          };
          renderMetaPills(lastAnalysisMeta);

          // Record usage
          if (lastAnalysisMeta.model) {
            await usageRecord({
              model:        lastAnalysisMeta.model,
              inputTokens:  lastAnalysisMeta.inputTokens,
              outputTokens: lastAnalysisMeta.outputTokens,
            }).catch(() => {});
          }

          // Store in pHash cache (single image only)
          if (images.length === 1 && capturedImages[0]?.blob) {
            const hash = await computePHash(capturedImages[0].blob);
            if (hash) await cachePut(hash, fullText, capturedImages[0]?.thumbnailDataUri || "").catch(() => {});
          }

          cleanup();
          return fullText;
        }
      }
    }
    cleanup();
    return fullText || null;

  } catch (err) {
    if (err.name === "AbortError") {
      toast("Analysis cancelled.");
      resultBody.innerHTML += "<p><em>Cancelled.</em></p>";
    } else if (!navigator.onLine && !isRetry) {
      // Queue for offline retry
      toast("📵 Offline — queued for later retry.");
      await queueAdd({ images, mode, tier, userNote }).catch(() => {});
      resultBody.innerHTML = `<p>📵 No connection. This scan has been queued and will automatically run when you're back online.</p>`;
    } else {
      toast(err.message, "error");
      resultBody.innerHTML += `<p style="color:var(--danger)">⚠️ ${err.message}</p>`;
    }
    cleanup();
    return null;
  }
}

function cleanup() {
  isAnalyzing = false;
  analyzeBtn.disabled = capturedImages.length === 0;
  statusBar.hidden = true;
  abortCtrl = null;
}

function renderMetaPills({ provider, model, fromCache }) {
  const pills = [];
  if (fromCache) {
    pills.push(`<span class="meta-pill cached">⚡ Local cache</span>`);
  } else {
    pills.push(`<span class="meta-pill groq">Groq</span>`);
    if (model) pills.push(`<span class="meta-pill">${model}</span>`);
  }
  resultMeta.innerHTML = pills.join("");
}

function renderResult(text, meta) {
  resultCard.hidden = false;
  resultBody.innerHTML = marked.parse(text);
  lastAnalysisText = text;
  lastAnalysisMeta = meta;
  renderMetaPills(meta);
}

// ─── Analyse button ───────────────────────────────────────────────────────────
analyzeBtn.addEventListener("click", async () => {
  if (!capturedImages.length || isAnalyzing) return;
  const images   = capturedImages.map((img) => img.base64);
  const userNote = userNoteEl.value.trim();
  await runAnalysis(images, selectedMode, selectedTier, userNote);
});

cancelBtn.addEventListener("click", () => { abortCtrl?.abort(); });

// ─── Result actions ───────────────────────────────────────────────────────────
copyBtn.addEventListener("click", () => {
  const text = resultBody.innerText || resultBody.textContent;
  if (!text) return toast("Nothing to copy.");
  navigator.clipboard.writeText(text).then(
    () => toast("Copied 📋", "success"),
    () => toast("Failed to copy.")
  );
});

saveBtn.addEventListener("click", async () => {
  if (!lastAnalysisText) return toast("Nothing to save.");
  const tag = prompt("Tag this scan (e.g. Pharmacology, Past Paper 2022) — or leave blank:");
  try {
    await historySave({
      thumbnailDataUri: capturedImages[0]?.thumbnailDataUri || "",
      allThumbnails:    capturedImages.map((i) => i.thumbnailDataUri),
      analysisText:     lastAnalysisText,
      mode:             selectedMode,
      tier:             selectedTier,
      provider:         lastAnalysisMeta.provider || "",
      model:            lastAnalysisMeta.model    || "",
      inputTokens:      lastAnalysisMeta.inputTokens  || 0,
      outputTokens:     lastAnalysisMeta.outputTokens || 0,
      userNote:         userNoteEl.value.trim(),
      tag:              tag || "",
    });
    toast("Saved to history 💾", "success");
    await refreshHistoryPanel();
  } catch (e) {
    toast("Save failed: " + e.message, "error");
  }
});

clearBtn.addEventListener("click", () => {
  capturedImages.length = 0;
  renderStrip();
  updateAnalyzeBtn();
  resultCard.hidden = true;
  resultBody.innerHTML = "";
  lastAnalysisText = "";
  toast("Cleared.");
});

// ─── Strip controls ───────────────────────────────────────────────────────────
imageStrip.addEventListener("click", (e) => {
  const btn = e.target.closest(".remove-btn");
  if (btn) removeImage(parseInt(btn.dataset.index, 10));
});

clearStripBtn.addEventListener("click", () => {
  capturedImages.length = 0;
  renderStrip();
  updateAnalyzeBtn();
});

addMoreBtn.addEventListener("click", () => {
  // Re-open camera if it stopped, or trigger file input as fallback
  if (isCameraActive()) {
    // camera already running — user just captures again
    toast("📷 Point camera at next page and tap Capture.");
  } else {
    fileInput.click();
  }
});

captureBtn.addEventListener("click", handleCapture);
fileInput.addEventListener("change", (e) => {
  if (e.target.files?.length) handleFileUpload(e.target.files);
  fileInput.value = "";
});

// ─── History panel ────────────────────────────────────────────────────────────
async function refreshHistoryPanel() {
  const items = await historyGetAll({ limit: 80 });
  historyBadge.hidden = items.length === 0;
  historyBadge.textContent = String(items.length);

  if (!items.length) {
    historyList.innerHTML = `<p class="empty-state">No scans saved yet.</p>`;
    return;
  }

  historyList.innerHTML = items.map((item) => `
    <div class="history-item" data-id="${item.id}">
      <img class="history-thumb"
           src="${item.thumbnailDataUri || "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs="}"
           alt="thumb" />
      <div class="history-info">
        <div class="history-title">${escapeHtml(truncate(item.analysisText, 60))}</div>
        <div class="history-meta">
          ${formatDate(item.createdAt)} · ${item.mode} · ${item.provider || ""}
        </div>
        ${item.tag ? `<span class="history-tag">${escapeHtml(item.tag)}</span>` : ""}
      </div>
    </div>
  `).join("");
}

historyList.addEventListener("click", async (e) => {
  const item = e.target.closest(".history-item");
  if (!item) return;
  const id = parseInt(item.dataset.id, 10);
  const records = await historyGetAll({ limit: 200 });
  const record  = records.find((r) => r.id === id);
  if (!record) return;

  // Load straight into main result card — no modal
  resultCard.hidden = false;
  resultBody.innerHTML = marked.parse(record.analysisText || "");
  lastAnalysisText = record.analysisText || "";
  lastAnalysisMeta = {
    provider: record.provider || "",
    model: record.model || "",
    inputTokens: record.inputTokens || 0,
    outputTokens: record.outputTokens || 0,
  };
  renderMetaPills({ ...lastAnalysisMeta, fromCache: false });
  resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Close the history panel
  historyPanel.classList.remove("open");
  historyPanel.setAttribute("aria-hidden", "true");
  panelOverlay.hidden = true;

  toast("Loaded from history.");
});

// ─── (Modal close now handled by inline HTML onclick attributes) ────────────

// ─── History toggle ────────────────────────────────────────────────────────
historyToggleBtn.addEventListener("click", () => {
  const opening = !historyPanel.classList.contains("open");
  historyPanel.classList.toggle("open");
  historyPanel.setAttribute("aria-hidden", String(!opening));
  panelOverlay.hidden = !opening;
  if (opening) refreshHistoryPanel();
});

clearHistoryBtn.addEventListener("click", async () => {
  if (!confirm("Clear all saved scans? This cannot be undone.")) return;
  await historyClear();
  await refreshHistoryPanel();
  toast("History cleared.");
});

// ─── Usage dashboard ──────────────────────────────────────────────────────────
dashboardBtn.addEventListener("click", async () => {
  const stats = await usageGetAll();
  resultCard.hidden = false;
  if (!stats.length) {
    resultBody.innerHTML = `<p style="color:var(--gray-400);text-align:center">No usage recorded yet.</p>`;
  } else {
    resultBody.innerHTML = `<h2>📊 Usage Dashboard</h2>` + stats.map((m) => `
      <div style="margin-bottom:1rem">
        <strong style="color:var(--primary-dark)">${m.month}</strong>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;margin-top:0.4rem">
          <div style="background:var(--gray-50);padding:0.5rem 0.75rem;border-radius:8px;border:1.5px solid var(--gray-200)">
            <div style="font-size:1.2rem;font-weight:700;color:var(--primary-dark)">${m.scans}</div>
            <div style="font-size:0.7rem;color:var(--gray-400)">Scans</div>
          </div>
          <div style="background:var(--gray-50);padding:0.5rem 0.75rem;border-radius:8px;border:1.5px solid var(--gray-200)">
            <div style="font-size:1.2rem;font-weight:700;color:var(--accent-dark)">${m.costUsd.toFixed(4)}</div>
            <div style="font-size:0.7rem;color:var(--gray-400)">Cost (USD)</div>
          </div>
        </div>
      </div>
    `).join("");
  }
  resultCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
  toast("Usage stats loaded.");
});

// ─── Utils ────────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, n) {
  return str && str.length > n ? str.slice(0, n) + "…" : (str || "");
}

function formatDate(ts) {
  return new Date(ts).toLocaleString("en-KE", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  // Configure marked for safe rendering
  marked.setOptions({ breaks: true, gfm: true });

  await initCamera();
  await refreshProviderStatus();
  await refreshHistoryPanel();
  updateOnlineStatus();

  // Retry queued items if online
  if (navigator.onLine) await drainOfflineQueue();
})();
