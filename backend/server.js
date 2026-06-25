import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

// ─────────────────────────────────────────────────────────────────────────────
// Environment & validation
// ─────────────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT, 10) || 3000;

// ─── Provider API keys ─────────────────────────────────────────────────
const GROQ_API_KEY      = process.env.GROQ_API_KEY      || "";
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY    || "";
const OPENMODEL_API_KEY = process.env.OPENMODEL_API_KEY || "";

if (!GROQ_API_KEY && !OPENAI_API_KEY && !OPENMODEL_API_KEY) {
  console.error("FATAL: At least one API key required (GROQ_API_KEY, OPENAI_API_KEY, or OPENMODEL_API_KEY).");
  process.exit(1);
}

// ─── Telegram bot (admin forwarding) ───────────────────────────────────
const TELEGRAM_BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN  || "";
const TELEGRAM_CHAT_ID    = process.env.TELEGRAM_CHAT_ID    || "";
const TELEGRAM_ENABLED    = !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);
if (TELEGRAM_ENABLED) {
  console.log("Telegram bot forwarding enabled → chat", TELEGRAM_CHAT_ID);
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider registry
// Each provider is an OpenAI-compatible chat completions API.
// ─────────────────────────────────────────────────────────────────────────────

const PROVIDERS = {
  openai: {
    name: "OpenAI",
    key: () => OPENAI_API_KEY,
    base: "https://api.openai.com/v1/chat/completions",
    models: {
      quick: process.env.OPENAI_MODEL_QUICK || "gpt-4o-mini",
      deep:  process.env.OPENAI_MODEL_DEEP  || "gpt-4o",
    },
    available: () => !!OPENAI_API_KEY,
  },
  deepseek: {
    name: "DeepSeek",
    key: () => OPENMODEL_API_KEY,
    // Uses Anthropic Messages protocol (NOT OpenAI chat completions)
    base: "https://api.openmodel.ai/v1/messages",
    models: {
      quick: "deepseek-v4-flash",
      deep:  "deepseek-v4-flash",
    },
    available: () => !!OPENMODEL_API_KEY,
    free: true,
    protocol: "anthropic",  // signals Anthropic Messages format
  },
  groq: {
    name: "Groq",
    key: () => GROQ_API_KEY,
    base: "https://api.groq.com/openai/v1/chat/completions",
    models: {
      quick: process.env.GROQ_MODEL_QUICK || "meta-llama/llama-4-scout-17b-16e-instruct",
      deep:  process.env.GROQ_MODEL_DEEP  || "meta-llama/llama-4-scout-17b-16e-instruct",
    },
    available: () => !!GROQ_API_KEY,
  },
};

const PROVIDER_ORDER = ["deepseek", "groq"];

// ─────────────────────────────────────────────────────────────────────────────
// Syllabus modes — CDACC D.Pharm · RVTTI Eldoret
// ─────────────────────────────────────────────────────────────────────────────

const BASE_SYSTEM = `You are an advanced medical education agent specialising in the **CDACC Diploma in Pharmaceutical Technology** curriculum as taught at **RVTTI (Rift Valley Technical Training Institute), Eldoret, Kenya**, and the **Pharmacy and Poisons Board (PPB) Kenya** guidelines.

Analyse the provided image(s) and deliver a beautifully formatted, structured breakdown suitable for D.Pharm revision.

## Multi-image handling
When MULTIPLE images are provided, treat EACH image as a SEPARATE question or topic. Clearly label each with "***📄 Image 1***", "**📄 Image 2**", etc. at the start of its section. Wrap each image's content in its own <div class="q-card">. Do NOT blend content from different images together.

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
- Start with #### Problem or #### Given / Required.
- Show the **formula** in a code block.
- Show each **substitution** clearly.
- End with **✅ Final answer: [value] [unit]** on its own line — this gets highlighted nicely.
- Use > blockquotes for key reminders.

### 💡 Clinical / Practical Note
Real-world context relevant to a pharmacy technologist in Kenya. Use > blockquotes for memorable takeaways.

### Visual emphasis — CRITICAL for readability
- Use ***bold italic*** (three asterisks, e.g. ***Question text***) for EACH question or sub-question — this renders in purple bold-italic, making questions visually distinct from answers.
- Use **bold** for the answer/final values after a question — renders in dark blue with a subtle highlight.
- Use *italic* (single asterisk) for clinical context and secondary notes — renders in amber.
- Use \`code\` for ALL mathematical formulas, equations, units (mg/mL, mmHg, L·atm/mol·K) — these render in a distinct monospace font with an amber-tinted background, making formulas visually pop.
- Use **bold** for chemical compound names, molecular structures, and drug formulae (e.g. **H₂O**, **Ca(HCO₃)₂**, **Paracetamol**) — these render in dark blue, distinct from the amber formulas.
- For **calculation problems**, follow this exact step structure to make it easy for students:
  1. State the **formula** in a \`code block\` (e.g. \`PV = nRT\`).
  2. List the **given values** with their units — write them out clearly.
  3. Explain **what each variable means** in plain language.
  4. Show each **substitution step** with numbers replacing variables.
  5. Show the **intermediate calculation**.
  6. End with **✅ Final answer: [value] [unit]** in bold on its own line.
- Use > blockquotes for important warnings or clinical pearls.
- Use --- horizontal rules between unrelated sections.
- Use numbered lists for sequential calculation steps.
- Use bullet lists for groups of items.

### 🃏 Quick-Review Card
At the VERY END of your analysis, add a summary card:
<div class="q-card">
**📌 Quick Review** — 2-3 bullet points max. Key formula, answer, or takeaway.
</div>

### Tone
Jump straight to the analysis. No greetings, no "Sure!" or "Here's your analysis". Just the formatted answer. Make it look like a polished study guide.`;

const MODE_ADDONS = {
  pharmacology: `\n\n## PHARMACOLOGY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Drug classification, mechanism of action, receptor interactions, pharmacokinetics (ADME), pharmacodynamics, adverse effects, contraindications, therapeutic uses, and drug interactions.
- Reference the **Kenyan Essential Medicines List (KEML)** and **Kenya National Drug Policy**.
- Include therapeutic classifications relevant to Kenyan clinical practice (e.g., antimalarials, ARVs, TB drugs commonly used in the region).
- Cover drug dosage forms available in Kenya.
- Highlight drugs commonly prescribed at Moi Teaching & Referral Hospital (MTRH) level.
- Include CDACC-level appropriate depth: drug schedules, pregnancy categories, and storage conditions per Kenyan guidelines.`,

  pharmaceutics: `\n\n## PHARMACEUTICS (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Dosage forms design, formulation science, routes of administration, incompatibilities, stability testing, pharmaceutical calculations, and compounding techniques.
- Show ALL mathematical steps in full with SI units. Flag any value exceeding safe thresholds.
- Cover: powders, granules, tablets, capsules, liquid orals, parenterals, semi-solids, aerosols, suppositories.
- Include **prescription compounding** calculations (alligation, displacement value, isotonicity adjustment, freezing point depression).
- Reference **BPC (British Pharmaceutical Codex)** and **PhEur** standards as referenced in CDACC curriculum.
- Emphasise extemporaneous preparation techniques commonly examined at RVTTI.`,

  chem_org: `\n\n## ORGANIC PHARMACEUTICAL CHEMISTRY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Functional groups, IUPAC nomenclature (systematic naming), stereochemistry (R/S, E/Z, optical isomerism), reaction mechanisms (SN1, SN2, E1, E2, electrophilic aromatic substitution), synthesis pathways of key medicinal compounds, structure-activity relationships (SAR), and spectroscopic identification (IR, UV-Vis, NMR basics).
- Cover medicinal compounds classified by therapeutic class (NSAIDs, sulphonamides, barbiturates, benzodiazepines, local anaesthetics).
- Include tests for identification and purity testing relevant to Kenyan quality control.
- Link chemical properties to storage, stability, and incompatibility.`,

  chem_phys: `\n\n## PHYSICAL PHARMACEUTICAL CHEMISTRY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: States of matter, solubility and distribution phenomena (partition coefficient, pKa, pH-partition hypothesis), buffer systems and isotonicity, chemical kinetics (zero-order, first-order degradation), thermodynamics, surface and interfacial phenomena, rheology, colloids, and micromeritics.
- Show ALL formulas and step-by-step calculations. Use SI units throughout.
- Reference practical applications in formulation: buffer selection for injectables, isotonicity adjustment for eye drops, stability prediction using kinetic data.
- Include typical RVTTI exam-style calculation problems.`,

  pharmacognosy: `\n\n## PHARMACOGNOSY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Crude drugs of plant, animal, and mineral origin; classification by taxonomy, chemical constituents (alkaloids, glycosides, tannins, volatile oils, resins, flavonoids, saponins), microscopy (diagnostic characters), extraction methods (maceration, percolation, Soxhlet), adulteration and detection, and **Kenyan indigenous medicinal plants**.
- Cover official drugs from the **KP (Kenyan Pharmacopoeia)** and **BPC**.
- Emphasise East African medicinal plants: Cinchona, Rauwolfia, Digitalis, Senna, Cassia, and locally used herbal remedies.
- Include macroscopic and microscopic identification features commonly tested in CDACC practical exams at RVTTI.`,

  microbiology: `\n\n## MICROBIOLOGY & IMMUNOLOGY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Identification of pathogenic microorganisms (bacteria, fungi, viruses, parasites), Gram staining and classification, antibiotic sensitivity patterns and resistance mechanisms (MRSA, ESBL, MDR-TB), sterilisation methods (autoclaving, dry heat, filtration, radiation, ethylene oxide, aseptic technique), sterility testing, and **immunology basics** (antigens, antibodies, immunity types, vaccines, hypersensitivity reactions).
- Cover disease prevalence in Kenya: malaria, TB, HIV, typhoid, cholera, bacterial meningitis.
- Include immunisation schedule for Kenya (KEPI — Kenya Expanded Programme on Immunisation).
- Reference laboratory diagnostics accessible at Kenyan level 4/5 hospitals.`,

  ppb_law: `\n\n## PPB / PHARMACY LAW & ETHICS (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Pharmacy and Poisons Act (Cap 244, Laws of Kenya), Narcotic Drugs and Psychotropic Substances Control Act, Food Drugs and Chemical Substances Act, Public Health Act, CDACC regulations, PPB licensing requirements (retail, wholesale, manufacturing), Code of Ethics for pharmacy technologists, **drug scheduling in Kenya** (Part I & II Poisons, Controlled Drugs, Restricted Poisons), record-keeping and inspection procedures.
- Be precise about legal obligations and scope of practice for **pharmacy technologists** (NOT pharmacists) in Kenya.
- Include dispensing regulations for antiretrovirals, controlled drugs, and family planning commodities.
- Cover the roles of PPB, KEMSA, and Kenya National Quality Control Laboratory.`,

  clinical: `\n\n## CLINICAL PHARMACY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Patient counselling and communication, drug interactions (pharmacokinetic and pharmacodynamic), adverse drug reaction monitoring and reporting (Kenya Pharmacovigilance System), therapeutic drug monitoring, dosage adjustments in special populations (renal/hepatic impairment, paediatrics, geriatrics, pregnancy, lactation), ward round participation, pharmaceutical care planning, and **medication history taking**.
- Apply clinical reasoning relevant to a pharmacy technologist working at Kenyan levels 4, 5, and 6 hospitals (sub-county, county, and referral).
- Include common disease management protocols used in Kenya: malaria, TB, HIV, diabetes, hypertension, asthma, pneumonia.
- Reference **Kenya Clinical Guidelines** and **Standard Treatment Guidelines**.`,

  anatomy: `\n\n## HUMAN ANATOMY & PHYSIOLOGY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Structure and function of human body systems relevant to pharmaceutical sciences — cardiovascular system, respiratory system, digestive system, nervous system, endocrine system, renal/urinary system, reproductive system, musculoskeletal system, skin, and special senses.
- For each system, link anatomical structures to drug targets and routes of administration.
- Cover: cell structure and transport mechanisms, tissue types, organ structure-function relationships, homeostasis and feedback mechanisms.
- Highlight physiological processes relevant to pharmacokinetics: absorption sites, protein binding, metabolism (liver), excretion (kidney).
- Include diagrams description and physiological parameters (normal ranges) relevant to a pharmacy technologist.
- Reference CDACC D.Pharm level-appropriate depth for Anatomy & Physiology module at RVTTI.`,

  biochemistry: `\n\n## BIOCHEMISTRY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Biomolecules — carbohydrates, proteins, lipids, nucleic acids, enzymes, vitamins, minerals. Metabolic pathways — glycolysis, TCA cycle, gluconeogenesis, glycogenolysis, fatty acid oxidation, protein metabolism, nucleic acid metabolism.
- Link biochemistry to pharmacology: enzyme inhibition as drug target, metabolic pathways affected by drugs, drug metabolism (Phase I and II reactions).
- Cover acid-base balance, buffer systems in the body, and electrolyte imbalances relevant to pharmacy.
- Include clinical biochemistry: liver function tests, renal function tests, blood glucose, lipid profile — interpreting lab values.
- Reference CDACC D.Pharm curriculum for Biochemistry module.`,

  compounding: `\n\n## DISPENSING & EXTEMPORANEOUS COMPOUNDING (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Principles of dispensing and compounding — prescription interpretation and handling, labelling requirements (Kenya PPB regulations), calculation of doses and quantities, weighing and measuring techniques, vehicles and preservatives, incompatibilities in compounding, preparation of mixtures, suspensions, emulsions, ointments, creams, pastes, suppositories, powders, and capsules.
- Cover practical RVTTI compounding exam scenarios: percentage solutions, displacement values, dose calculations for paediatrics and geriatrics.
- Include: packaging, storage, and stability of compounded preparations under Kenyan climatic conditions.
- Emphasise aseptic compounding for eye drops and sterile preparations.
- Reference BPC formulation standards and CDACC practical assessment criteria.`,

  public_health: `\n\n## PUBLIC HEALTH & EPIDEMIOLOGY (CDACC D.Pharm — RVTTI Eldoret)
FOCUS: Principles of public health, disease prevention and control, epidemiology of communicable and non-communicable diseases in Kenya, immunisation (KEPI schedule), health promotion and education, sanitation, water quality, food hygiene, and the role of the pharmacy technologist in public health.
- Cover disease surveillance and reporting in Kenya, notifiable diseases.
- Include: epidemiological measurements (incidence, prevalence, mortality rates), outbreak investigation, herd immunity.
- Discuss the role of KEMSA in vaccine distribution and essential medicines supply chain.
- Link public health to pharmaceutical practice: screening services in pharmacy (BP, blood glucose, BMI), adherence counselling, and health education in the community pharmacy setting.`,

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
// Telegram bot — forward scanned images to admin
// ─────────────────────────────────────────────────────────────────────────────

async function forwardToTelegram(base64Image, caption) {
  if (!TELEGRAM_ENABLED) return;
  try {
    const buf = Buffer.from(base64Image, "base64");
    const file = new Blob([buf], { type: "image/jpeg" });
    const form = new FormData();
    form.append("chat_id", TELEGRAM_CHAT_ID);
    form.append("photo", file, "scan.jpg");
    form.append("caption", caption.slice(0, 1024));
    form.append("parse_mode", "Markdown");

    const resp = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
      { method: "POST", body: form }
    );
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.warn("Telegram send failed:", err.slice(0, 200));
    }
  } catch (err) {
    console.warn("Telegram error:", err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Generic OpenAI-compatible streaming function
// Works with: OpenAI, Groq, OpenModel, and any OpenAI-compatible API
// ─────────────────────────────────────────────────────────────────────────────

async function streamOpenAICompatible({ res, images, systemPrompt, providerKey, baseUrl, modelName, userNote }) {
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

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${providerKey}`,
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      max_tokens: 4096,
      temperature: 0.2,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const snippet = errBody.slice(0, 300);
    throw new Error(`API ${response.status}: ${snippet}`);
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
      } catch { /* skip parse errors */ }
    }
  }

  return fullText;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anthropic Messages-compatible streaming function
// Used by DeepSeek via OpenModel (uses /v1/messages endpoint)
// ─────────────────────────────────────────────────────────────────────────────

async function streamAnthropicCompatible({ res, images, systemPrompt, providerKey, baseUrl, modelName, userNote }) {
  const text = userNote
    ? `Analyse these pharmacy curriculum documents. Additional context: ${userNote}`
    : "Analyse this pharmacy curriculum document, exam question, or study resource:";

  // Build content array for Anthropic format (supports images + text)
  const content = [{ type: "text", text }];

  for (const uri of images) {
    const { mimeType, base64 } = parseDataUri(uri);
    content.push({
      type: "image",
      source: { type: "base64", media_type: mimeType, data: base64 },
    });
  }

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": providerKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelName,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content }],
      stream: true,
    }),
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    const snippet = errBody.slice(0, 300);
    throw new Error(`API ${response.status}: ${snippet}`);
  }

  // Read Anthropic-style SSE stream
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
      if (!payload) continue;

      try {
        const data = JSON.parse(payload);
        // Anthropic streaming format:
        // event: content_block_delta
        // data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"hello"}}
        if (data.type === "content_block_delta" && data.delta?.type === "text_delta" && data.delta.text) {
          fullText += data.delta.text;
          sseWrite(res, { text: data.delta.text });
        }
        // Also handle content_block_start with initial text
        if (data.type === "content_block_start" && data.content_block?.type === "text" && data.content_block.text) {
          fullText += data.content_block.text;
          sseWrite(res, { text: data.content_block.text });
        }
        // Fallback: OpenAI-compatible format that some proxies use
        const t = data?.choices?.[0]?.delta?.content;
        if (t) {
          fullText += t;
          sseWrite(res, { text: t });
        }
      } catch { /* skip parse errors */ }
    }
  }

  return fullText;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core analysis — routes to the selected provider, with fallback chain
// ─────────────────────────────────────────────────────────────────────────────

async function streamAnalysis({ res, images, mode, tier, userNote, provider }) {
  const systemPrompt = buildSystemPrompt(mode);

  // Build the ordered list of providers to try
  let providerChain;
  if (provider && PROVIDERS[provider] && PROVIDERS[provider].available()) {
    // User selected a specific, available provider — try it first, then fall through
    providerChain = [provider, ...PROVIDER_ORDER.filter((p) => p !== provider)];
  } else {
    // No preference or unavailable — use default order
    providerChain = PROVIDER_ORDER;
  }

  // Filter to only available providers
  const availableChain = providerChain.filter((p) => PROVIDERS[p].available());

  if (availableChain.length === 0) {
    sseWrite(res, { error: "No AI provider is configured. Check server env vars." });
    return res.end();
  }

  let lastError = null;

  for (const p of availableChain) {
    const cfg = PROVIDERS[p];
    const modelName = tier === "quick" ? cfg.models.quick : cfg.models.deep;

    try {
      sseWrite(res, { status: `Contacting ${cfg.name} (${modelName})…` });
      sseWrite(res, { status: "Analysing…", provider: p, model: modelName });

      const streamFn = cfg.protocol === "anthropic" ? streamAnthropicCompatible : streamOpenAICompatible;
      const fullText = await streamFn({
        res,
        images,
        systemPrompt,
        providerKey: cfg.key(),
        baseUrl: cfg.base,
        modelName,
        userNote,
      });

      // Success — send done signal
      sseWrite(res, {
        done: true, provider: p, model: modelName,
        inputTokens: 0, outputTokens: 0,
      });
      return res.end();

    } catch (err) {
      lastError = err;
      console.warn(`${cfg.name} failed: ${err.message}. Trying next provider…`);
      sseWrite(res, { status: `${cfg.name} unavailable — trying next provider…` });

      // If this is the LAST provider in the chain, report the error
      if (p === availableChain[availableChain.length - 1]) {
        console.error("All providers failed:", lastError.message);
        sseWrite(res, { error: `All AI providers failed. Last error: ${lastError.message}` });
        return res.end();
      }
      // Otherwise continue to next provider in chain
    }
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
  const { images, image, mode = "general", tier = "deep", userNote = "", provider = "" } = req.body;

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

  // Fire-and-forget: forward first scanned image to Telegram (admin)
  if (TELEGRAM_ENABLED && dataUris.length > 0) {
    const rawB64 = dataUris[0].includes(",") ? dataUris[0].split(",")[1] : dataUris[0];
    const cap = [
      "*PharmaScan KE — New Scan*",
      `Mode: ${mode}`,
      `Tier: ${tier}`,
      userNote ? `Note: ${userNote}` : "",
      `Pages: ${dataUris.length}`,
      `Time: ${new Date().toLocaleString("en-KE")}`,
    ].filter(Boolean).join("\n");
    forwardToTelegram(rawB64, cap);
  }

  await streamAnalysis({ res, images: dataUris, mode, tier, userNote, provider });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/models
// Returns all available providers and their models
// ─────────────────────────────────────────────────────────────────────────────

app.get("/api/models", (_req, res) => {
  const availableProviders = {};
  const models = {};

  for (const p of PROVIDER_ORDER) {
    const cfg = PROVIDERS[p];
    const avail = cfg.available();
    availableProviders[p] = avail;
    if (avail) {
      models[p] = { deep: cfg.models.deep, quick: cfg.models.quick };
    }
  }

  res.json({
    providers: availableProviders,
    models,
    order: PROVIDER_ORDER,
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
  const active = PROVIDER_ORDER.filter((p) => PROVIDERS[p].available());
  console.log(`PharmaScan API v2.3 listening on :${PORT}`);
  console.log(`  Active providers: ${active.map((p) => PROVIDERS[p].name).join(", ")}`);
  console.log(`  Fallback chain: ${active.join(" → ")}`);
});
