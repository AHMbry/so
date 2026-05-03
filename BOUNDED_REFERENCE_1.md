# Bounded - Project Reference

> This file is the single source of truth for building and maintaining the Bounded VS Code extension. Read this before changing code.

---

## 1. What Is Bounded?

Bounded is a VS Code extension that helps programming learners notice and reduce over-reliance on externally inserted code. It monitors behavioral patterns during a coding session and computes a Behavioral Reliance Index (BRI): a score that reflects how much code was inserted without enough follow-up engagement.

Bounded now treats both pasted code and AI/snippet-style inserted code as inserted code. The UI should use "inserted" language. Some internal TypeScript fields still use legacy "paste" names for compatibility.

Core principles:

- Non-intrusive by default: runs in the background and never blocks the user.
- Privacy-first: code content is not persisted, exported, or transmitted.
- Fully offline: no network calls or cloud dependencies.
- Awareness over enforcement: uses neutral guidance and nudges, not punishment.
- False-positive resistant: code copied from the same file or workspace should not count as an external insert.

---

## 2. Architecture Overview

Bounded follows a 3-layer architecture with event-driven communication.

```text
Presentation Layer
  VS Code WebViews, status bar text, notification nudges
  Sidebar Panel, Dashboard Panel, Onboarding Flow
        |
        | postMessage API
        v
Business Logic Layer
  Extension Host TypeScript modules
  Event Listener, Insert Classifier, BRI Calculator,
  Session Tracker, Mode Manager, Alert Controller,
  Report Generator
        |
        | local file access
        v
Data Layer
  Local JSON files only
  BRI State Store, Session History Store, Report Exporter
```

Strict dependency rule: Presentation -> Business -> Data. Do not skip layers.

---

## 3. Folder Structure

```text
bounded/
|-- src/
|   |-- extension.ts                  Entry point and runtime wiring
|   |-- types.ts                      Shared app types
|   |-- business/
|   |   |-- eventListener.ts          Captures VS Code document changes
|   |   |-- pasteClassifier.ts        Inserted-code classifier
|   |   |-- briCalculator.ts          Core BRI computation
|   |   |-- sessionTracker.ts         Per-session stats
|   |   |-- modeManager.ts            Standard / Strict mode
|   |   |-- alertController.ts        Threshold monitoring
|   |   |-- reportGenerator.ts        Session report assembly
|   |-- data/
|   |   |-- briStateStore.ts          Read/write current BRI JSON
|   |   |-- sessionHistoryStore.ts    Read/write session history JSON
|   |   |-- reportExporter.ts         Local report export
|   |-- presentation/
|       |-- sidebarPanel.ts           Activity bar WebView provider
|       |-- dashboardPanel.ts         Full dashboard WebView
|       |-- onboardingFlow.ts         Multi-screen onboarding WebView
|-- media/
|   |-- icon.svg
|   |-- sidebar.css
|   |-- dashboard.css
|   |-- onboarding.css
|-- package.json
|-- tsconfig.json
|-- README.md
```

---

## 4. package.json Key Fields

Current extension activation:

```json
{
  "activationEvents": ["onStartupFinished", "onView:boundedSidebarView"],
  "main": "./out/extension.js"
}
```

Main contributed commands:

- `bounded.openDashboard`
- `bounded.toggleMode`
- `bounded.generateReport`

Main contributed view:

- Activity bar container: `bounded-sidebar`
- WebView view id: `boundedSidebarView`

Main configuration:

- `bounded.mode`: `Standard` or `Strict`
- `bounded.alertThreshold`: default `0.75`

---

## 5. Functional Requirements

| ID | Requirement |
|----|-------------|
| FR-01 | Record inserted-code events with line count and timestamp. |
| FR-02 | Treat clipboard pastes, snippets, and AI-agent multi-line insertions as inserted code when they meet the classifier threshold. |
| FR-03 | Calculate a Behavioral Reliance Index per session. |
| FR-04 | Do not increase BRI for code copied from the same file or same workspace/codebase. |
| FR-05 | Increase BRI when external inserted code is introduced into the session. |
| FR-06 | Reduce or reverse an inserted block's BRI contribution when the user edits or removes that block. |
| FR-07 | Track typed lines, inserted lines, insert events, and longest typing streak. |
| FR-08 | Display BRI as a score out of 100 in the UI while keeping the internal value on a 0.0-1.0 scale. |
| FR-09 | Generate a session report containing typed lines, inserted lines, insert events, BRI, mode, and summary text. |
| FR-10 | Support Standard mode and Strict mode with immediate switching. |
| FR-11 | Save current BRI state locally when the workspace/document is saved. |
| FR-12 | Provide sidebar, dashboard, status bar, onboarding, and neutral threshold nudges. |
| FR-13 | Provide local light/dark theme toggles in WebViews. |

---

## 6. Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NF-01 | Keep document-change handling lightweight and synchronous where possible. |
| NF-02 | Use a best-effort workspace text cache for internal-copy detection. |
| NF-03 | Warm the workspace cache asynchronously and avoid counting external inserts while the cache is still warming. |
| NF-04 | Do not store, export, or transmit code content. Transient in-memory text comparison is allowed only for internal-copy detection. |
| NF-05 | Remain fully functional offline. |
| NF-06 | Use neutral, non-accusatory language. Avoid terms such as "cheating", "failed", or "wrong". |
| NF-07 | Mode switching must take effect immediately. |
| NF-08 | UI should feel quiet, modern, and VS Code-native, not flashy or marketing-heavy. |

---

## 7. BRI Logic Rules

Internal BRI is a number from `0.0` to `1.0`. UI BRI is displayed as `internalBRI * 100`.

State labels:

```text
0.00 - 0.40  low
0.41 - 0.74  moderate
0.75 - 1.00  severe
```

Status colors:

- Low: green
- Moderate: yellow
- Severe: red

Per inserted block:

```text
baseContribution = min(0.05 + insertedLineCount * 0.005, 0.15)
adjustedContribution = baseContribution * (1 - modificationDepth)
```

Rules:

- External inserted code increases BRI.
- Internal same-file or same-workspace inserts do not increase BRI.
- Editing inserted code applies a graded reduction based on `modificationDepth`.
- Removing/undoing an inserted block reverses that block's contribution.
- Higher inserted-line ratio raises BRI.
- Long typing streaks and higher typed-line ratio reduce BRI.
- Modification credit is scaled by project size, so small edits in larger projects reduce BRI gradually.
- Rapid insert frequency adds a separate adjustment when more than 3 active inserts occur within 10 minutes.
- If there is at least one active external insert, the internal BRI floor is `0.05` so the UI never shows `0` while inserted code remains active.
- Final internal BRI is clamped to `0.0-1.0` and rounded to 2 decimals.

Session-level adjustments currently use:

- `linesTyped`
- `linesPasted` internally, displayed as inserted lines
- `pasteEventCount` internally, displayed as insert events
- `longestTypingStreak`
- Active insert frequency in a recent time window

---

## 8. Inserted-Code Detection

The file is still named `pasteClassifier.ts`, but it now acts as an inserted-code classifier.

Classifier behavior:

- Qualifies multi-line insertions with at least 3 non-empty inserted lines.
- Handles clipboard paste, snippet insertion, and AI-agent insertion patterns through VS Code document-change events.
- Uses the previous version of the same document to detect same-file copies.
- Uses open workspace documents to detect copied workspace code.
- Uses an asynchronously warmed workspace text cache to detect copied codebase content even when source files are not open.
- Skips common generated/dependency folders such as `.git`, `node_modules`, `out`, `dist`, `build`, and `.vscode-test`.
- Skips large files above the configured cache-size limit.
- While the workspace cache is warming, large external-looking inserts are ignored to reduce false positives.
- Tracks multi-location edits as multiple ranges rather than a single broad range.

Privacy boundary:

- Code text may be compared in memory for classification.
- Code text must not be written to BRI state, history, reports, logs, telemetry, or network.

---

## 9. Data Schemas

### BRI State Store (`bri-state.json`)

Internal field names currently preserve legacy paste terminology:

```json
{
  "currentBRI": 0.42,
  "stateLabel": "moderate",
  "activeMode": "Standard",
  "lastSaved": "2026-05-03T10:30:00Z",
  "sessionSnapshot": {
    "linesTyped": 120,
    "linesPasted": 80,
    "pasteEventCount": 5,
    "longestTypingStreak": 45,
    "briDeltaSinceStart": 0.12
  }
}
```

UI mapping:

- `linesPasted` -> Lines Inserted
- `pasteEventCount` -> Insert Events

### Session History Store (`session-history.json`)

```json
[
  {
    "date": "2026-05-03",
    "finalBRI": 0.42,
    "linesTyped": 120,
    "linesPasted": 80,
    "pasteEventCount": 5,
    "modeActive": "Standard"
  }
]
```

### Conceptual ERD Entities

Settings:

- `user_id`
- `current_mode`
- `privacy_accepted`
- `alert_threshold`

Session:

- `session_id`
- `start_at`
- `end_at`
- `total_lines_typed`
- `total_lines_inserted`
- `final_bri_score`
- `is_active`

Behavioral_Event:

- `event_id`
- `session_id`
- `occurred_at`
- `event_type` (`INSERT`, `UNDO`, `MODIFICATION`)
- `line_count`
- `is_internal`
- `is_undone`
- `modification_depth`

Historical_Stat:

- `stat_date`
- `aggregate_bri`
- `session_count`

---

## 10. Event Flow

```text
User action: type, insert, edit, undo, save
        |
        v
Event Listener captures VS Code document change
        |
        v
Inserted-code classifier determines internal vs external
        |
        v
Session Tracker updates typed/inserted stats
        |
        v
BRI Calculator updates BRI and state label
        |
        v
Alert Controller checks thresholds
        |
        v
Sidebar/Dashboard receive refreshed state
        |
        v
Status bar updates: BRI score, state color, mode
        |
        v
On save, BRI State Store writes local JSON
```

---

## 11. Presentation Layer

### Sidebar Panel

- Compact VS Code-native coaching panel.
- Shows BRI ring, score out of 100, state label, active mode, and session stats.
- Uses "inserted" terminology in visible text.
- Includes dashboard, report, and mode actions.
- Includes local light/dark theme toggle.
- Uses neutral button styling with subtle hover/press animation.

### Dashboard Panel

- Full dashboard WebView for session review.
- Shows BRI score, label, metric strip, trend chart, behavioral patterns, history, and report actions.
- Uses modern system fonts and quiet styling.
- Includes local light/dark theme toggle.

### Onboarding Flow

- Multi-screen WebView with progress steps.
- Explains BRI, mode choice, and privacy.
- Includes local light/dark theme toggle.
- Toggle changes contrast visibly when pressed.
- Has polished navigation and hover animation.
- Current development behavior: onboarding is forced to appear on every activation by returning `false` from `isComplete()`.

### Status Bar

- Shows BRI score, state, and active mode in the bottom VS Code bar.
- Uses green for low, yellow for moderate, and red for severe.
- Severe state must never render white.

### Alerts

- Alert Controller triggers neutral nudges based on BRI thresholds and active mode.
- Standard mode stays quieter.
- Strict mode nudges earlier.

---

## 12. Technology Choices

| Component | Technology | Reason |
|-----------|------------|--------|
| Extension language | TypeScript | VS Code standard and strong typing |
| UI rendering | VS Code WebView | Required for rich extension UI |
| IPC | VS Code `postMessage` | Standard WebView communication |
| Persistence | Local JSON via Node.js APIs | Offline, simple, recoverable |
| Event capture | VS Code workspace/document APIs | Supported editor-event surface |
| Styling | Plain CSS in `media/` | Lightweight and easy to package |

---

## 13. Current Implementation Status

Implemented:

- BRI state persistence and session history persistence.
- Inserted-code classification for paste/snippet/AI-style multi-line inserts.
- Same-file and same-workspace false-positive filtering.
- Workspace text cache warm-up for internal-copy detection.
- Graded BRI reductions when inserted code is modified.
- Undo/removal reversal for inserted blocks.
- Minimum BRI floor while active external inserted code remains.
- Session-level BRI adjustments from typing, inserted lines, and rapid insert frequency.
- Sidebar, dashboard, onboarding, report generation, mode toggling, and status bar updates.
- Visible UI copy changed from pasted code to inserted code.
- Light/dark toggles for WebViews.
- Moderate yellow and severe red status colors.

Known cleanup / future work:

- Internal field names still use some paste terminology (`linesPasted`, `pasteEventCount`) for compatibility.
- The classifier file name remains `pasteClassifier.ts` even though it now detects broader inserted-code events.
- Onboarding is currently forced to appear every activation for development/testing.
- Automated test coverage is still needed for BRI math, inserted-code classification, and line-count edge cases.
- Dashboard live trend fidelity can be expanded once more historical data is collected.

---

## 14. Hard Rules

- Never persist or transmit code content.
- Never add network calls.
- Keep Presentation -> Business -> Data boundaries intact.
- Use `postMessage` for WebView to Extension Host communication.
- Do not count same-file or same-workspace copied code as external inserted code.
- Keep BRI internal scale `0.0-1.0`; convert to `0-100` only for display.
- Use neutral language in all alerts and coaching copy.
- Mode switching must be immediate.
- Preserve existing user changes when editing the codebase.

---

## 15. Members

- Rayane Fajri - 161325
- Ahmed Bourouay - 162440
- Mohammed Ateich - 162502
- Mohammed El Jahid - 163723
