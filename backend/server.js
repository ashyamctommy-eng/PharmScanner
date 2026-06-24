import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

// ─────────────────────────────────────────────────────────────────────────────
// Environment & validation
// ─────────────────────────────────────────────────────────────────────────────

const PORT              = parseInt(process.env.PORT, 10) || 3000;
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error("FATAL: GEMINI_API_KEY must be set.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// AI clients
// ─────────────────────────────────────────────────────────────────────────────

// Model routing
const GEMINI_DEEP   = process.env.GEMINI_MODEL_DEEP  || "gemini-1.5-pro";
const GEMINI_QUICK  = process.env.GEMINI_MODEL_QUICK || "gemini-1.5-flash-8b";

// ─────────────────────────────────────────────────────────────────────────────
// Syllabus modes
// ─────────────────────────────────────────────────────────────────────────────

const BASE_SYSTEM = `You are an advanced medical education agent specialising in the Kenya National Examinations Council (KNEC) Diploma in Pharmaceutical Technology curriculum and Pharmacy and Poisons Board (PPB) guidelines. Analyse the provided image and deliver a structured breakdown. Jump straight to the analysis without conversational filler using this format:

1. **Identified Concept**: State the drug class, physiological system, or legal framework involved.
2. **Systematic Breakdown**: Solve or explain the problem step-by-step with flawless logic.
3. **Clinical/Practical Note**: Provide a brief, real-world context relevant to a practicing pharmacy technologist in Kenya.`;

const MODE_ADDONS = {
  pharmacology: `\n\nFOCUS: Pharmacology mode — classify by drug class, mechanism of action, receptor interactions, pharmacokinetics (ADME), and adverse effects. Reference Kenyan Essential Medicines List (KEML) where applicable.`,
  pharmaceutics: `\n\nFOCUS: Pharmaceutics & Calculations mode — show ALL mathematical steps in full with SI units. Verify every dose against standard references. Flag any value that exceeds safe paediatric/adult thresholds.`,
  ppb_law: `\n\nFOCUS: PPB / Legal & Regulatory mode — cite the relevant section of the Pharmacy and Poisons Act (Cap 244, Kenya), applicable schedules, and licensing requirements. Be precise about legal obligations.`,
  microbiology: `\n\nFOCUS: Microbiology & Sterilisation mode — identify organisms, antibiotic coverage, resistance patterns, and sterilisation/aseptic technique relevant to Kenyan hospital pharmacy.`,
  clinical: `\n\nFOCUS: Clinical Pharmacy mode — focus on patient counselling points, drug interactions, contraindications, and monitoring parameters a pharmacy technologist in Kenya would manage.`,
  general: ``,
};

function buildSystemPrompt(mode) {
  return BASE_SYSTEM + (MODE_ADDONS[mode] || "");
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE helpers
// ─────────────────────────────────────────────────────────────────────────────

function sseSetup(res) {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
}

function sseWrite(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse a data-URI into { mimeType, base64 }
// ─────────────────────────────────────────────────────────────────────────────

function parseDataUri(dataUri) {
  const comma = dataUri.indexOf(",");
  if (comma === -1) return { mimeType: "image/jpeg", base64: dataUri };
  const meta = dataUri.slice(5, comma); // drop "data:"
  const [mimeType] = meta.split(";");
  return { mimeType: mimeType || "image/jpeg", base64: dataUri.slice(comma + 1) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini streaming — primary provider
// ─────────────────────────────────────────────────────────────────────────────

async function streamGemini({ res, images, systemPrompt, modelName, userNote }) {
  const text = userNote
    ? `Analyse these pharmacy curriculum documents. Additional context: ${userNote}`
    : "Analyse this pharmacy curriculum document, exam question, or study resource:";

  const parts = [
    { text },
    ...images.map((uri) => {
      const { mimeType, base64 } = parseDataUri(uri);
      return { inlineData: { mimeType, data: base64 } };
    }),
  ];

  // Direct fetch — bypasses SDK, works with any API key
  const url = `${GEMINI_BASE}/${modelName}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Gemini API ${response.status}: ${errBody.slice(0, 300)}`);
  }

  // Read SSE stream from direct API
  const reader = response.body.getReader();
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
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const data = JSON.parse(payload);
        // Standard Gemini stream: candidates[0].content.parts[0].text
        const t = data?.candidates?.[0]?.content?.parts?.[0]?.text || data?.text;
        if (t) {
          fullText += t;
          sseWrite(res, { text: t });
        }
      } catch { /* skip */ }
    }
  }

  // Estimate token usage
  const estInputTokens  = Math.ceil(parts.reduce((s, p) => {
    if (p.text) return s + p.text.length / 4;
    if (p.inlineData) return s + 258;
    return s;
  }, 0));
  const estOutputTokens = Math.ceil(fullText.length / 4);

  sseWrite(res, {
    done: true, provider: "gemini", model: modelName,
    inputTokens: estInputTokens, outputTokens: estOutputTokens,
  });
  res.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core analysis — Gemini only
// ─────────────────────────────────────────────────────────────────────────────

async function streamAnalysis({ res, images, mode, tier, userNote }) {
  const systemPrompt = buildSystemPrompt(mode);
  const geminiModel  = tier === "quick" ? GEMINI_QUICK : GEMINI_DEEP;

  try {
    sseWrite(res, { status: `Contacting Gemini (${geminiModel})…` });
    sseWrite(res, { status: "Analysing…", provider: "gemini", model: geminiModel });
    await streamGemini({ res, images, systemPrompt, modelName: geminiModel, userNote });
  } catch (err) {
    console.error("Gemini error:", err.message);
    sseWrite(res, { error: `Gemini error: ${err.message}` });
    res.end();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Express app
// ─────────────────────────────────────────────────────────────────────────────

const app = express();

app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: "*" }));
app.use(morgan("short"));
app.use(express.json({ limit: "30mb" }));

const limiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please wait a moment." },
});
app.use("/api", limiter);

app.use(express.static("frontend"));

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/analyze
// ─────────────────────────────────────────────────────────────────────────────

app.post("/api/analyze", async (req, res) => {
  const { images, image, mode = "general", tier = "deep", userNote = "" } = req.body;

  const rawImages = images || (image ? [image] : null);

  if (!rawImages || !Array.isArray(rawImages) || rawImages.length === 0) {
    return res.status(400).json({ error: "Provide 'images' (array) or 'image' (string)." });
  }
  if (rawImages.length > 10) {
    return res.status(400).json({ error: "Maximum 10 images per request." });
  }

  const dataUris = rawImages.map((img) =>
    img.startsWith("data:") ? img : `data:image/jpeg;base64,${img}`
  );

  sseSetup(res);
  await streamAnalysis({ res, images: dataUris, mode, tier, userNote });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/models
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/models", (_req, res) => {
  res.json({
    gemini: true,
    models: {
      deep:  GEMINI_DEEP,
      quick: GEMINI_QUICK,
    },
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => res.json({ status: "ok", ts: Date.now() }));

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`PharmaScan API v2.1 listening on :${PORT} — Gemini (free)`);
});
