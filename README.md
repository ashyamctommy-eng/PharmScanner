# 💊 PharmaScan KE v2

**KNEC Diploma in Pharmaceutical Technology — AI Document Scanner**

A mobile-responsive web app for Kenyan pharmacy students. Point your phone at any curriculum resource, exam paper, or study note — get a structured, KNEC-grounded AI analysis in seconds. Works offline, saves history locally, and costs near nothing per scan.

---

## ✨ What's New in v2

| Feature | Details |
|---|---|
| **Tiered AI models** | ⚡ Quick (gpt-4o-mini, ~20× cheaper) or 🔬 Deep (gpt-4o, max accuracy) |
| **Claude Haiku fallback** | When OpenAI is down/rate-limited, Claude kicks in automatically |
| **Multi-image scanning** | Capture up to 10 pages in one analysis (full past papers) |
| **6 Syllabus Modes** | Pharmacology · Pharmaceutics · PPB/Law · Microbiology · Clinical · General |
| **Local scan history** | All results saved in IndexedDB — 100% on-device, no server needed |
| **Perceptual hash cache** | Scanned a page before? Instant answer from local cache, zero API cost |
| **Blur detection** | Camera warns you before capturing a blurry image |
| **Offline queue** | Failed scans auto-retry when connectivity returns |
| **Usage dashboard** | Track monthly scans, token counts, and estimated USD cost |
| **Typewriter streaming** | Live animated cursor as results stream in |

---

## 🚀 Deploy on Railway (3 steps)

1. **Push to GitHub**

2. **New Railway project → Deploy from GitHub repo**

3. **Add environment variables:**

   | Variable | Required | Value |
   |---|---|---|
   | `OPENAI_API_KEY` | ✅ Yes | `sk-...` from platform.openai.com |
   | `ANTHROPIC_API_KEY` | ⬜ Optional | `sk-ant-...` from console.anthropic.com (enables Claude fallback) |
   | `OPENAI_MODEL_DEEP` | ⬜ Optional | default `gpt-4o` |
   | `OPENAI_MODEL_QUICK` | ⬜ Optional | default `gpt-4o-mini` |
   | `CLAUDE_MODEL` | ⬜ Optional | default `claude-3-haiku-20240307` |

Railway auto-detects `Dockerfile` + `railway.json`, builds, and gives you a live `.railway.app` URL.

---

## 🧪 Local Development

```bash
cd backend
npm install
cp ../.env.example ../.env
# Edit .env — paste your keys
node server.js
# Open http://localhost:3000
```

---

## 📁 File Map

```
pharmacy-scanner/
├── backend/
│   ├── server.js          # Express relay — tiered models, SSE streaming, Claude fallback
│   └── package.json
├── frontend/
│   ├── index.html         # Main app shell — all UI panels
│   ├── style.css          # Full medical-blue academic theme
│   ├── app.js             # Main orchestrator — wires everything together
│   ├── camera.js          # Camera, compression, blur detection, thumbnails
│   └── db.js              # IndexedDB — history, cache, queue, usage stats
├── Dockerfile             # Multi-stage production build (non-root)
├── railway.json           # Railway deploy config + health check
├── .env.example           # All env variables documented
└── README.md
```

---

## 💸 Cost Estimate

| Scenario | Model | Cost/scan | 500 scans |
|---|---|---|---|
| Definition / short Q | gpt-4o-mini | ~$0.0002 | ~$0.10 |
| Complex calculation | gpt-4o | ~$0.004 | ~$2.00 |
| Seen before (cached) | Local cache | **$0.00** | **$0.00** |

**Tip:** Default to Quick mode for daily revision. Use Deep only for calculation-heavy KNEC papers.

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
POST /api/analyze  { images[], mode, tier, userNote }
       │
       ├─► OpenAI GPT-4o/mini  ──────┐
       │   (primary)                 │  SSE stream → live markdown
       └─► Claude Haiku fallback ────┘
                 (on OpenAI 429/5xx)
       │
       ▼
IndexedDB (history + cache + usage stats)
```

---

## 🧠 Syllabus Modes

Each mode injects a specialised sub-prompt into the system message:

| Mode | Focus |
|---|---|
| General | Full KNEC curriculum baseline |
| Pharmacology | Drug class, MOA, ADME, adverse effects, KEML |
| Pharmaceutics | Step-by-step dosage calculations with SI units, safety thresholds |
| PPB / Law | Pharmacy and Poisons Act Cap 244, schedules, licensing |
| Microbiology | Organisms, antibiotic coverage, resistance, aseptic technique |
| Clinical | Patient counselling, interactions, monitoring parameters |

---

## 🛡 Security

- API keys in server-side env vars — never exposed to browser
- Rate-limited: 30 req/min per IP
- Helmet security headers
- Non-root Docker user
- All history/cache data stays 100% on the student's device

---

## ⚠️ Disclaimer

For educational use only. Always verify AI-generated answers against your lecturers, KNEC syllabi, and official reference materials.

---

*Built for pharmacy students across Kenya. 💊*
