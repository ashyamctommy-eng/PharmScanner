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
- Use \`code\` for ALL mathematical formulas, equations, units (mg/mL, mmHg, L·atm/mol·K), and chemical formulae (H₂O, Ca(HCO₃)₂) — these render in a distinct monospace font with an amber-tinted background, making formulas visually pop.
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
  console.log(`PharmaScan API v2.2 listening on :${PORT} — CDACC RVTTI Eldoret Syllabus`);
});
