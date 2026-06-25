# 💊 PharmaScan KE v3

**CDACC Diploma in Pharmaceutical Technology — AI Document Scanner**  
*Built for RVTTI Eldoret D.Pharm students*

A mobile-responsive web app for Kenyan pharmacy students. Point your phone at any curriculum resource, exam paper, or study note — get a structured, CDACC-grounded AI analysis in seconds. Works offline, saves history locally, and costs **nothing** per scan.

---

## ✨ What's New in v3

| Feature | Details |
|---|---|
| **DeepSeek V4 Flash (FREE)** | Primary AI model — completely free via OpenModel, no credit card needed |
| **Groq fallback** | Automatic failover — if DeepSeek is down, Groq kicks in seamlessly |
| **Provider selector** | Tap to switch between DeepSeek and Groq from the settings panel |
| **14 Syllabus Modes** | General · Pharmacology · Pharmaceutics · Org. Chem · Phys. Chem · Pharmacognosy · Microbiology · PPB/Law · Clinical · Anatomy & Phys. · Biochemistry · Compounding · Public Health · Quiz |
| **Multi-image scanning** | Capture up to 10 pages in one analysis (full past papers) |
| **Local scan history** | All results saved in IndexedDB — 100% on-device, no server needed |
| **Perceptual hash cache** | Scanned a page before? Instant answer from local cache, zero API cost |
| **Blur detection** | Camera warns you before capturing a blurry image |
| **Offline queue** | Failed scans auto-retry when connectivity returns |
| **Usage dashboard** | Track monthly scan counts |
| **Typewriter streaming** | Live animated cursor as results stream in |
| **Dark mode** | Switch between light and dark themes |
| **Animations & polish** | Smooth card transitions, hover effects, responsive mobile layout |

---

## 🚀 Deploy on Railway (2 steps)

1. **Push to GitHub**

2. **New Railway project → Deploy from GitHub repo**

3. **Add environment variables:**

   | Variable | Required | Value |
   |---|---|---|
   | `OPENMODEL_API_KEY` | ✅ Yes | `om-...` from [console.openmodel.ai](https://console.openmodel.ai) |
   | `GROQ_API_KEY` | ⬜ Optional | `gsk-...` from [console.groq.com](https://console.groq.com) (enables fallback) |

Railway auto-detects `Dockerfile` + `railway.json`, builds, and gives you a live `.railway.app` URL.

---

## 🧪 Local Development

```bash
cd backend
npm install
cp ../.env.example ../.env
# Edit .env — paste your OpenModel API key (and Groq for fallback)
node server.js
# Open http://localhost:3456
```

---

## 📁 File Map

```
PharmaScan/
├── backend/
│   ├── server.js          # Express relay — multi-provider routing, SSE streaming, auto-failover
│   └── package.json
├── frontend/
│   ├── index.html         # Main app shell — all UI panels
│   ├── style.css          # Medical-blue academic theme + dark mode
│   ├── app.js             # Main orchestrator — camera, provider select, SSE, IndexedDB
│   ├── camera.js          # Camera, compression, blur detection, thumbnails
│   └── db.js              # IndexedDB — history, cache, queue, usage stats
├── Dockerfile             # Multi-stage production build (non-root)
├── railway.json           # Railway deploy config + health check
├── .env.example           # All env variables documented
└── README.md
```

---

## 🏗 How It Works

```
Camera / File Upload
       │
       ▼
Canvas Compression (≤1500px JPEG 80%)
       │
       ├─► pHash Check ─► Local Cache Hit? ─► Instant result, $0.00
       │
       ▼
POST /api/analyze  { images[], mode, tier, userNote, provider }
       │
       ├─► DeepSeek V4 Flash (via OpenModel) ────┐
       │   (primary, FREE)                       │  SSE stream → live markdown
       └─► Groq (Llama 4 Scout) ─────────────────┘
                 (automatic fallback on failure)
       │
       ▼
IndexedDB (history + cache + usage stats)
```

---

## 🤖 AI Providers

The app ships with **two providers** and an automatic fallback chain:

| Provider | Model | Cost | Status |
|---|---|---|---|
| **DeepSeek** (via OpenModel) | `deepseek-v4-flash` | **🆓 FREE** | Primary |
| **Groq** | `llama-4-scout-17b-16e` | **🆓 FREE** | Fallback |

If the primary provider fails (downtime, rate limit, etc.), the server automatically falls through to the next available provider. No interruption to the user.

You can also **manually select** your preferred provider from the settings panel in the app.

---

## 🧠 Syllabus Modes

Each mode injects a specialised sub-prompt into the system message:

| Mode | Focus |
|---|---|
| General | Full CDACC curriculum baseline |
| Pharmacology | Drug class, MOA, ADME, adverse effects, KEML |
| Pharmaceutics | Step-by-step dosage calculations with SI units, safety thresholds |
| Organic Chemistry | IUPAC nomenclature, stereochemistry, reaction mechanisms, SAR |
| Physical Chemistry | Solubility, buffers, kinetics, thermodynamics, surface phenomena |
| Pharmacognosy | Crude drugs, Kenyan medicinal plants, microscopy, extraction methods |
| Microbiology | Pathogens, Gram staining, antibiotics, sterilisation, KEPI schedule |
| PPB / Law | Pharmacy and Poisons Act Cap 244, drug scheduling, ethics |
| Clinical | Patient counselling, drug interactions, pharmacovigilance |
| Anatomy & Physiology | Body systems, homeostasis, physiological parameters |
| Biochemistry | Biomolecules, metabolic pathways, clinical lab values |
| Compounding | Extemporaneous preparation, displacement values, aseptic technique |
| Public Health | Disease prevention, epidemiology, KEMSA, health promotion |
| Quiz | Generate 5 MCQs from the scanned content with answer key |

---

## 🛡 Security

- API keys in server-side env vars — never exposed to browser
- Rate-limited: 30 req/min per IP
- Helmet security headers
- Non-root Docker user
- All history/cache data stays 100% on the student's device

---

## ⚠️ Disclaimer

For educational use only. Always verify AI-generated answers against your lecturers, CDACC syllabi, and official reference materials.

---

*Built for pharmacy students across Kenya. 💊*  
*Code and concept by **ashyamctommy@gmail.com** — **Poriot**_  
*RVTTI Eldoret · D.Pharm 2026*

