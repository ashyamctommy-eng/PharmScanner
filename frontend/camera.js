/* ═══════════════════════════════════════════════════════════════════════════
   camera.js — PharmaScan KE
   Camera management · Canvas compression · Blur detection · Multi-capture
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── Config ─────────────────────────────────────────────────────────────────
const COMPRESS_MAX_DIM  = 1500;   // max px on any side
const COMPRESS_QUALITY  = 0.80;   // JPEG quality
const BLUR_THRESHOLD    = 60;     // Laplacian variance below this = blurry
const MAX_IMAGES        = 10;     // multi-image cap

// ─── State ───────────────────────────────────────────────────────────────────
let mediaStream = null;

// ─── Camera lifecycle ────────────────────────────────────────────────────────

/**
 * Start rear-facing camera and attach to <video> element.
 * Returns true if camera started, false if permission denied.
 */
export async function startCamera(videoEl) {
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: false,
    });
    videoEl.srcObject = mediaStream;
    await videoEl.play();
    return true;
  } catch {
    return false;
  }
}

export function stopCamera() {
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }
}

export function isCameraActive() {
  return !!mediaStream;
}

// ─── Capture current video frame ─────────────────────────────────────────────

/**
 * Snapshot the current video frame and return a raw (uncompressed) Blob.
 */
export async function captureFrame(videoEl) {
  const track    = mediaStream?.getVideoTracks()[0];
  const settings = track?.getSettings() || {};
  const w = settings.width  || videoEl.videoWidth  || 1280;
  const h = settings.height || videoEl.videoHeight || 720;

  const canvas = document.createElement("canvas");
  canvas.width  = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(videoEl, 0, 0, w, h);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => b ? resolve(b) : reject(new Error("Frame capture failed")),
      "image/jpeg", 0.95
    )
  );
}

// ─── Compression ─────────────────────────────────────────────────────────────

/**
 * Downscale and JPEG-compress a Blob.
 * Downscales to COMPRESS_MAX_DIM on the longest side, preserving aspect ratio.
 * @returns {Blob} compressed JPEG
 */
export function compressImage(fileOrBlob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(fileOrBlob);

    img.onload = () => {
      URL.revokeObjectURL(url);
      let { naturalWidth: w, naturalHeight: h } = img;
      if (w > COMPRESS_MAX_DIM || h > COMPRESS_MAX_DIM) {
        const ratio = Math.min(COMPRESS_MAX_DIM / w, COMPRESS_MAX_DIM / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement("canvas");
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      canvas.toBlob(
        (b) => b ? resolve(b) : reject(new Error("Compression failed")),
        "image/jpeg", COMPRESS_QUALITY
      );
    };

    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Image load failed")); };
    img.src = url;
  });
}

// ─── Blur detection (Laplacian variance) ─────────────────────────────────────

/**
 * Estimate image sharpness via Laplacian variance on a small greyscale sample.
 * Returns a variance score — below BLUR_THRESHOLD means likely blurry.
 */
export function measureBlur(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const SIZE = 128; // sample size — fast enough for real-time
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = SIZE;
      const ctx = canvas.getContext("2d");
      ctx.filter = "grayscale(1)";
      ctx.drawImage(img, 0, 0, SIZE, SIZE);

      const { data } = ctx.getImageData(0, 0, SIZE, SIZE);
      const pixels = new Float32Array(SIZE * SIZE);
      for (let i = 0, j = 0; i < data.length; i += 4, j++) pixels[j] = data[i];

      // Laplacian kernel: [0,1,0,1,-4,1,0,1,0]
      let sum = 0, sumSq = 0, count = 0;
      for (let y = 1; y < SIZE - 1; y++) {
        for (let x = 1; x < SIZE - 1; x++) {
          const idx  = y * SIZE + x;
          const lap  = -4 * pixels[idx]
            + pixels[idx - 1] + pixels[idx + 1]
            + pixels[idx - SIZE] + pixels[idx + SIZE];
          sum   += lap;
          sumSq += lap * lap;
          count++;
        }
      }
      const mean = sum / count;
      const variance = (sumSq / count) - mean * mean;
      resolve(Math.abs(variance));
    };

    img.onerror = () => { URL.revokeObjectURL(url); resolve(999); }; // if err, assume sharp
    img.src = url;
  });
}

export function isBlurry(varianceScore) {
  return varianceScore < BLUR_THRESHOLD;
}

// ─── Thumbnail generator ─────────────────────────────────────────────────────

/**
 * Create a small thumbnail data URI (120×90) from a blob — used for history previews.
 */
export function makeThumbnail(blob) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const W = 120, H = 90;
      const canvas = document.createElement("canvas");
      canvas.width = W; canvas.height = H;
      canvas.getContext("2d").drawImage(img, 0, 0, W, H);
      resolve(canvas.toDataURL("image/jpeg", 0.7));
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(""); };
    img.src = url;
  });
}

// ─── Blob ↔ base64 ───────────────────────────────────────────────────────────

/**
 * Convert a Blob to a bare base64 string (no data URI prefix).
 */
export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const str = reader.result;
      const comma = str.indexOf(",");
      resolve(comma !== -1 ? str.slice(comma + 1) : str);
    };
    reader.onerror = () => reject(new Error("Base64 conversion failed"));
    reader.readAsDataURL(blob);
  });
}

export { MAX_IMAGES };
