# Bounded — Claude Code Reference

> This file is the single source of truth for Claude Code when building the Bounded VS Code extension. Read this before writing any code.

---

## 1. What Is Bounded?

Bounded is a **VS Code extension** that helps programming learners detect and reduce over-reliance on AI-generated or externally sourced code. It monitors behavioral patterns during coding sessions and computes a **Behavioral Reliance Index (BRI)** — a numeric score that reflects how much the user is accepting external code without engaging with it.

**Core principles:**
- Non-intrusive by default — runs in the background, never blocks the user
- Privacy-first — no code content is ever stored or transmitted, only behavioral metadata
- Fully offline — zero network calls, zero cloud dependencies
- Awareness over enforcement — nudges, not restrictions

---

## 2. Architecture Overview

Bounded follows a **3-layer (N-Tier) architecture** with event-driven internal communication.

```
┌─────────────────────────────────────────┐
│         Presentation Layer              │
│  (VS Code WebView — HTML/CSS/JS)        │
│  Sidebar Panel, Dashboard, Alert Banner │
│  Status Bar Item, Onboarding Flow       │
└────────────────┬────────────────────────┘
                 │ postMessage API (both ways)
┌────────────────▼────────────────────────┐
│         Business Logic Layer            │
│  (Extension Host — TypeScript/Node.js)  │
│  Event Listener, Paste Classifier,      │
│  BRI Calculator, Session Tracker,       │
│  Mode Manager, Alert Controller,        │
│  Report Generator                       │
└────────────────┬────────────────────────┘
                 │ Node.js fs module
┌────────────────▼────────────────────────┐
│           Data Layer                    │
│  (Local JSON files — no DB, no cloud)   │
│  BRI State Store, Session History Store │
│  PDF Export (on-demand, local only)     │
└─────────────────────────────────────────┘
```

**Strict dependency rule:** Presentation → Business → Data. No layer skips another.

---

## 3. Folder Structure

```
bounded/
├── src/
│   ├── extension.ts              ← Entry point (activate / deactivate)
│   ├── business/
│   │   ├── eventListener.ts      ← Captures VS Code editor events
│   │   ├── pasteClassifier.ts    ← Internal vs external paste detection
│   │   ├── briCalculator.ts      ← Core BRI computation
│   │   ├── sessionTracker.ts     ← Per-session stats
│   │   ├── modeManager.ts        ← Standard / Strict mode
│   │   ├── alertController.ts    ← Threshold monitoring + alert trigger
│   │   └── reportGenerator.ts   ← Assembles session report
│   ├── data/
│   │   ├── briStateStore.ts      ← Read/write BRI state JSON
│   │   └── sessionHistoryStore.ts ← Read/write session history JSON
│   └── presentation/
│       ├── sidebarPanel.ts       ← WebView sidebar provider
│       ├── dashboardPanel.ts     ← Full dashboard WebView
│       ├── alertBanner.ts        ← Dismissible alert banner
│       ├── statusBarItem.ts      ← Bottom status bar
│       └── onboardingFlow.ts     ← First-launch multi-screen WebView
├── media/
│   ├── icon.svg                  ← Activity bar icon
│   ├── sidebar.css               ← Sidebar WebView styles
│   └── dashboard.css             ← Dashboard WebView styles
├── package.json
├── tsconfig.json
├── .vscodeignore
├── .gitignore
└── README.md
```

---

## 4. package.json Key Fields

```json
{
  "name": "bounded",
  "displayName": "Bounded",
  "description": "Detect and reduce over-reliance on AI-generated code through behavioral analysis.",
  "version": "0.0.1",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onStartupFinished"],
  "main": "./out/extension.js",
  "contributes": {
    "commands": [
      { "command": "bounded.openDashboard", "title": "Bounded: Open Dashboard" },
      { "command": "bounded.toggleMode", "title": "Bounded: Toggle Mode (Standard / Strict)" },
      { "command": "bounded.generateReport", "title": "Bounded: Generate Session Report" }
    ],
    "viewsContainers": {
      "activitybar": [
        { "id": "bounded-sidebar", "title": "Bounded", "icon": "media/icon.svg" }
      ]
    },
    "views": {
      "bounded-sidebar": [
        { "id": "boundedSidebarView", "name": "BRI Overview", "type": "webview" }
      ]
    },
    "configuration": {
      "properties": {
        "bounded.mode": {
          "type": "string",
          "enum": ["Standard", "Strict"],
          "default": "Standard"
        },
        "bounded.alertThreshold": {
          "type": "number",
          "default": 0.75
        }
      }
    }
  }
}
```

---

## 5. TypeScript Config

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "./out",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", ".vscode-test"]
}
```

---

## 6. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | Record the number of lines and timestamp of each paste event |
| FR-02 | Detect paste events when multiple large pastes occur within a short time window |
| FR-03 | Calculate a Behavioral Reliance Index (BRI) per session |
| FR-04 | BRI shall NOT change when pasted content originates from within the same workspace |
| FR-05 | BRI shall INCREASE when large code blocks are pasted without meaningful modification |
| FR-06 | BRI shall DECREASE when a paste is undone, reversing that paste's exact contribution |
| FR-07 | Generate a session report containing lines typed, lines pasted, and BRI score |
| FR-08 | Display a dismissible alert when BRI crosses the severe reliance threshold |
| FR-09 | Support Standard mode (quiet until high BRI) and Strict mode (nudges start earlier) |
| FR-10 | SHALL NOT store or transmit the content of any pasted or typed code |
| FR-11 | Save the current BRI state to a local file every time the user saves their workspace |

---

## 7. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Paste event detection must register within **100ms** of the event occurring |
| NF-03 | Alert trigger must occupy less than **10% of screen** and be dismissible via Esc |
| NF-05 | Session report must be readable in under 2 minutes |
| NF-06 | Alert language must be neutral — no punishment or failure language |
| NF-07 | Mode switching must take effect **immediately** with no restart |
| NF-09 | Extension must be **fully functional offline** — zero network calls |
| NF-11 | BRI state must survive unexpected VS Code closure by recovering last saved state |

---

## 8. BRI Logic Rules

```
BRI is a numeric score from 0.0 to 1.0 representing reliance severity.

State labels:
  0.0 – 0.40  →  LOW
  0.41 – 0.74 →  MODERATE
  0.75 – 1.0  →  SEVERE  ← alert triggers here

Rules per event:
  - External paste, large block, no meaningful modification → BRI increases (FR-05)
  - Paste undone → BRI decreases by that paste's exact contribution (FR-06)
  - Internal paste (from same workspace) → no BRI change (FR-04)

Mode behavior:
  - Standard: silent until SEVERE threshold
  - Strict: nudges begin at MODERATE, escalate at SEVERE
```

---

## 9. Data Schemas

### BRI State Store (`bri-state.json`)
```json
{
  "currentBRI": 0.42,
  "stateLabel": "moderate",
  "activeMode": "Standard",
  "lastSaved": "2025-04-21T10:30:00Z",
  "sessionSnapshot": {
    "linesTyped": 120,
    "linesPasted": 80,
    "pasteEventCount": 5,
    "unmodifiedPastes": 3,
    "longestTypingStreak": 45
  }
}
```

### Session History Store (`session-history.json`)
```json
[
  {
    "date": "2025-04-21",
    "finalBRI": 0.42,
    "linesTyped": 120,
    "linesPasted": 80,
    "pasteEventCount": 5,
    "modeActive": "Standard"
  }
]
```

### ERD Entities

**Settings** — `user_id (PK)`, `current_mode`, `privacy_accepted`, `alert_threshold`

**Session** — `session_id (PK)`, `user_id (FK)`, `start_at`, `end_at`, `total_lines_typed`, `total_lines_pasted`, `final_bri_score`, `is_active`

**Behavioral_Event** — `event_id (PK)`, `session_id (FK)`, `occurred_at`, `event_type (PASTE/UNDO/MODIFICATION)`, `line_count`, `is_internal`, `is_undone`, `modification_depth`

**Historical_Stat** — `stat_date (PK)`, `user_id (FK)`, `aggregate_bri`, `session_count`

---

## 10. Event Flow (Internal Communication)

```
User action (paste / type / undo / save)
        ↓
Event Listener Module (captures VS Code API event)
        ↓
Paste Classifier → is it internal or external?
Session Tracker  → update session stats
        ↓
BRI Calculator → update BRI value + state label
        ↓
Alert Controller → has severe threshold been crossed?
        ↓
postMessage → Sidebar Panel re-renders with new BRI
        ↓ (if alert)
Alert Banner appears in editor
        ↓ (on workspace save)
BRI State Store writes to disk (FR-11)
```

---

## 11. Presentation Layer Components

| Component | Description |
|-----------|-------------|
| **Sidebar Panel** | Primary WebView. Shows BRI ring gauge, numeric score, state label, session snapshot table, mode toggle, CTA to dashboard |
| **Alert Banner** | Dismissible inline banner at bottom of editor. Appears at SEVERE threshold. Dismissible via Esc or close button. Max 10% screen height |
| **Full Dashboard View** | On-demand WebView. Shows BRI trends over time, session history, behavioral patterns, report generation + PDF download |
| **Status Bar Item** | Persistent item in bottom VS Code status bar. Shows BRI score, active mode, paste count at all times |
| **Onboarding Flow** | Multi-screen WebView on first install. Feature highlights, BRI explainer, mode selection, T&C |

---

## 12. Technology Choices

| Component | Technology | Reason |
|-----------|------------|--------|
| Extension language | TypeScript | VS Code standard; strong typing for event logic |
| UI rendering | VS Code WebView (HTML/CSS/JS) | Only supported rich UI mechanism in VS Code |
| IPC (UI ↔ Logic) | VS Code postMessage API | Required by VS Code architecture |
| Persistence | JSON via Node.js `fs` | No external deps; human-readable; supports recovery |
| PDF export | Local HTML-to-PDF (no cloud) | Offline; no external rendering service |
| Event capture | VS Code workspace + document API | Only sanctioned way to observe editor events |

---

## 13. Build Phases

| Phase | What Gets Built |
|-------|----------------|
| **Phase 1** | Project scaffold — folder structure, package.json, tsconfig, extension.ts entry point, status bar placeholder |
| **Phase 2** | Data layer — JSON read/write helpers for BRI state store and session history store |
| **Phase 3** | Event Listener + Paste Classifier — capture paste events, classify internal vs external |
| **Phase 4** | BRI Calculator + Session Tracker — compute BRI score, track per-session stats |
| **Phase 5** | Mode Manager + Alert Controller — Standard/Strict modes, threshold alerts |
| **Phase 6** | Presentation Layer — Sidebar WebView, status bar, alert banner |
| **Phase 7** | Dashboard + Report Generator — full dashboard, PDF export |
| **Phase 8** | Onboarding Flow — first-launch multi-screen WebView |

---

## 14. Hard Rules (Never Break These)

- **Never store or transmit code content** — only counts, scores, timestamps (FR-10)
- **Never make network calls** — extension must work fully offline (NF-09)
- **Never skip a layer** — Presentation never talks to Data directly
- **Always use postMessage** for WebView ↔ Extension Host communication
- **BRI must update within 100ms** of a paste event (NF-01)
- **Alert language must be neutral** — no words like "cheating", "wrong", "failed" (NF-06)
- **Mode switch must be instant** — no restart, no reload (NF-07)
- **Internal pastes never affect BRI** (FR-04)

---

## 15. Members

- Rayane Fajri — 161325
- Ahmed Bourouay — 162440
- Mohammed Ateich — 162502
- Mohammed El Jahid — 163723
