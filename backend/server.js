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
const GROQ_DEEP     = process.env.GROQ_MODEL_DEEP  || "meta-llama/llama-4-scout-17b-16e-instruct";
const GROQ_QUICK    = process.env.GROQ_MODEL_QUICK || "meta-llama/llama-4-scout-17b-16e-instruct";

// ─────────────────────────────────────────────────────────────────────────────
// Syllabus modes
// ─────────────────────────────────────────────────────────────────────────────

const BASE_SYSTEM = `You are an advanced medical education agent specialising in the Kenya National Examinations Council (KNEC) Diploma in Pharmaceutical Technology curriculum and Pharmacy and Poisons Board (PPB) guidelines. Analyse the provided image(s) and deliver a beautifully formatted, structured breakdown.

## Multi-image handling
When MULTIPLE images are provided, treat EACH image as a SEPARATE question or topic. Clearly label each with "**📄 Image 1**", "**📄 Image 2**", etc. at the start of its section. Wrap each image's content in its own <div class="q-card">. Do NOT blend content from different images together.

## Single-image handling
When only ONE image is provided, proceed normally without image labels.

## Formatting rules — FOLLOW STRICTLY:

### Cards for each question
Wrap EACH question/problem (and each Image section in multi-image mode) in:
<div class="q-card">
...content...
</div>
This creates a bordered card. Leave a blank line before and after.

### Section structure
Use markdown headings (## or ###), dividers (---), icons like 💊📋⚕️🧪📏🔬, and this section order:

### 🎯 Identified Concept
A concise statement of the drug class, physiological system, or legal framework involved.

### 📝 Systematic Breakdown
Step-by-step logic. For calculations:
- Start with \`#### Problem\` or \`#### Given / Required\`.
- Show the **formula** in a code block.
- Show each **substitution** clearly.
- End with \`**✅ Final answer: [value] [unit]**\` on its own line — this gets highlighted nicely.
- Use > blockquotes for key reminders.

### 💡 Clinical / Practical Note
Real-world context relevant to a pharmacy technologist in Kenya. Use > blockquotes for memorable takeaways.

### Visual emphasis — CRITICAL for readability
- Use \`**\`####\` headings\`** (4 hashes) for EACH question or sub-topic heading — these will render in blue.
- Use \`**\`**bold**\`**\` for all final answers, key numbers, drug names, and important values — these will render in dark blue with a subtle highlight.
- Use `*italic*` for clinical context and secondary notes — renders in amber.
- Use \`code\` for units (mg/mL, mmHg, etc.) and formulas.
- Use > blockquotes for important warnings or clinical pearls.
- Use --- horizontal rules between unrelated sections.
- Use numbered lists for sequential steps.
- Use bullet lists for groups of items.

### 🃏 Quick-Review Card
At the VERY END of your analysis, add a summary card:
<div class="q-card">
**📌 Quick Review** — 2-3 bullet points max. Key formula, answer, or takeaway.
</div>

### Tone
Jump straight to the analysis. No greetings, no "Sure!" or "Here's your analysis". Just the formatted answer. Make it look like a polished study guide.`;

const MODE_ADDONS = {
  pharmacology: `\n\nFOCUS: PHARMACOLOGY — classify by drug class, mechanism of action, receptor interactions, pharmacokinetics (ADME), adverse effects, contraindications, and therapeutic uses. Reference the Kenyan Essential Medicines List (KEML) and CDACC D.Pharm level-appropriate content for RVTTI Eldoret.`,
  pharmaceutics: `\n\nFOCUS: PHARMACEUTICS — focus on dosage forms, formulation science, routes of administration, incompatibilities, stability, and pharmaceutical calculations. Show ALL mathematical steps in full with SI units. Flag any value exceeding safe thresholds. Reference CDACC D.Pharm curriculum.`,
  chem_org: `\n\nFOCUS: ORGANIC PHARMACEUTICAL CHEMISTRY — cover functional groups, IUPAC nomenclature, stereochemistry, reaction mechanisms (SN1, SN2, E1, E2), synthesis of key drug compounds, structure-activity relationships (SAR), and spectroscopic identification. Reference CDACC D.Pharm Organic Chemistry module.`,
  chem_phys: `\n\nFOCUS: PHYSICAL PHARMACEUTICAL CHEMISTRY — cover states of matter, solubility, partition coefficient, buffers, isotonicity, kinetics of degradation, thermodynamics, surface and interfacial phenomena, rheology, and colloids. Show ALL formulas and calculations. Reference CDACC D.Pharm Physical Chemistry module for RVTTI Eldoret.`,
  pharmacognosy: `\n\nFOCUS: PHARMACOGNOSY — cover crude drugs of plant, animal, and mineral origin; classification by chemical constituents (alkaloids, glycosides, tannins, volatile oils, resins); microscopy; extraction methods; adulteration; and Kenyan medicinal plants. Reference CDACC D.Pharm curriculum.`,
  microbiology: `\n\nFOCUS: MICROBIOLOGY & STERILISATION — identify organisms, Gram staining, antibiotic sensitivity patterns, resistance mechanisms, sterilisation methods (autoclaving, dry heat, filtration, radiation, ethylene oxide), aseptic technique, and sterility testing as per CDACC D.Pharm.`,
  ppb_law: `\n\nFOCUS: PPB / LEGAL & REGULATORY — cite the Pharmacy and Poisons Act (Cap 244, Kenya), Narcotics Act, Food Drugs and Chemical Substances Act, CDACC regulations, licensing requirements, ethical practice, and drug scheduling. Be precise about legal obligations for pharmacy technologists in Kenya.`,
  clinical: `\n\nFOCUS: CLINICAL PHARMACY — patient counselling, drug interactions, adverse drug reaction monitoring, therapeutic drug monitoring, dosage adjustments in special populations, ward round participation, and pharmaceutical care plans relevant to a pharmacy technologist in Kenya.`,
  quiz: `\n\nFOCUS: QUIZ MODE — Based ONLY on the content visible in the image, generate exactly 5 multiple-choice questions (A, B, C, D). Put each question in its own <div class="q-card">. After listing all 5, provide an answer key in a <div class="q-card" style="background:#f0fdf4;border-color:#22c55e"> with the correct answers and brief explanations. Do NOT include any other analysis — just the quiz and answer key.`,
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
