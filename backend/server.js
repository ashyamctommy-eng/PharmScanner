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
const GROQ_API_KEY      = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.error("FATAL: GROQ_API_KEY must be set.");
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Groq models (free, no credit card needed)
// ─────────────────────────────────────────────────────────────────────────────

const GROQ_BASE     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_DEEP     = process.env.GROQ_MODEL_DEEP  || "llama-3.2-90b-vision-preview";
const GROQ_QUICK    = process.env.GROQ_MODEL_QUICK || "llama-3.2-11b-vision-preview";

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
// Groq streaming — OpenAI-compatible API, free vision models
// ─────────────────────────────────────────────────────────────────────────────

async function streamGroq({ res, images, systemPrompt, modelName, userNote }) {
  const text = userNote
    ? `Analyse these pharmacy curriculum documents. Additional context: ${userNote}`
    : "Analyse this pharmacy curriculum document, exam question, or study resource:";

  const content = [
    { type: "text", text },
    ...images.map((uri) => ({
      type: "image_url",
      image_url: { url: uri },
    })),
  ];

  const response = await fetch(GROQ_BASE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      max_tokens: 2048,
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new Error(`Groq API ${response.status}: ${errBody.slice(0, 300)}`);
  }

  // Read OpenAI-style SSE stream
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
        const t = data?.choices?.[0]?.delta?.content;
        if (t) {
          fullText += t;
          sseWrite(res, { text: t });
        }
      } catch { /* skip */ }
    }
  }

  sseWrite(res, {
    done: true, provider: "groq", model: modelName,
    inputTokens: 0, outputTokens: 0,
  });
  res.end();
}

// ─────────────────────────────────────────────────────────────────────────────
// Core analysis — Groq (free, no credit card)
// ─────────────────────────────────────────────────────────────────────────────

async function streamAnalysis({ res, images, mode, tier, userNote }) {
  const systemPrompt = buildSystemPrompt(mode);
  const modelName = tier === "quick" ? GROQ_QUICK : GROQ_DEEP;

  try {
    sseWrite(res, { status: `Contacting Groq (${modelName})…` });
    sseWrite(res, { status: "Analysing…", provider: "groq", model: modelName });
    await streamGroq({ res, images, systemPrompt, modelName, userNote });
  } catch (err) {
    console.error("Groq error:", err.message);
    sseWrite(res, { error: `Groq error: ${err.message}` });
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
    groq: true,
    models: {
      deep:  GROQ_DEEP,
      quick: GROQ_QUICK,
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
  console.log(`PharmaScan API v2.1 listening on :${PORT} — Groq (free, no CC)`);
});
