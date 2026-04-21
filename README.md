# Bounded

**Detect and reduce over-reliance on AI-generated code through behavioral analysis.**

Bounded is a VS Code extension that tracks your coding behavior in real time and computes a **Behavioral Reliance Index (BRI)** — a score from 0 to 1 reflecting how much your session leans on AI-generated or externally-pasted code versus original keystrokes.

---

## Running Locally

```bash
npm install
```

Then press **F5** in VS Code to launch the Extension Development Host. The Bounded icon will appear in the Activity Bar and the status bar will show `$(pulse) BRI: --`.

---

## Architecture (3 Layers)

| Layer | Responsibilities |
|---|---|
| **Presentation** | Sidebar panel, status bar item, alert banner, WebView dashboard |
| **Business Logic** | Event listener, paste classifier, BRI calculator, session tracker, mode manager, alert controller, report generator |
| **Data** | Local JSON state store (BRI + session history), PDF export — no network, no cloud, no code content stored |

---

## Planned Phases

| Phase | Description |
|---|---|
| **Phase 1** | Project scaffold (this phase) — compilable skeleton, no logic |
| **Phase 2** | Core tracking — event listener, paste classifier, BRI calculator, status bar updates |
| **Phase 3** | Presentation — sidebar WebView, alert banner, mode toggling |
| **Phase 4** | Data persistence — JSON store, session history, report generator |
| **Phase 5** | Polish — packaging, settings UI, onboarding flow |

---

## Privacy

Bounded stores **only behavioral metadata** (keystroke counts, paste events, edit ratios). No source code, no file contents, and no network calls — ever.
