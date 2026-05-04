/**
 * extension.ts
 * Entry point for the Bounded VS Code extension.
 * Wires the full pipeline: data recovery → business logic → presentation.
 *
 * Layer order (strict — no skipping):
 *   Presentation ← postMessage → Business → Data
 */

import * as vscode from 'vscode';
import { BehavioralEvent, BRIState, BoundedMode, BRIStateLabel } from './types';
import { readBRIState, writeBRIState } from './data/briStateStore';
import { appendSessionRecord } from './data/sessionHistoryStore';
import { EventListenerModule } from './business/eventListener';
import { SessionTracker } from './business/sessionTracker';
import { BRICalculator } from './business/briCalculator';
import { ModeManager } from './business/modeManager';
import { AlertController } from './business/alertController';
import { SidebarPanel } from './presentation/sidebarPanel';
import { DashboardPanel } from './presentation/dashboardPanel';
import { ReportGenerator } from './business/reportGenerator';
import { OnboardingFlow } from './presentation/onboardingFlow';

// ── Status bar helper ─────────────────────────────────────────────────────────

/**
 * Updates both the text and the theme color of the status bar item
 * based on the current BRI severity label.
 */
function updateStatusBar(
  item: vscode.StatusBarItem,
  bri: number,
  label: BRIStateLabel,
  mode: BoundedMode
): void {
  item.text = `$(pulse) BRI: ${Math.round(bri * 100)} | ${mode}`;
  switch (label) {
    case 'low':
      item.color = new vscode.ThemeColor('terminal.ansiGreen');
      break;
    case 'moderate':
      item.color = new vscode.ThemeColor('terminal.ansiYellow');
      break;
    case 'severe':
      item.color = new vscode.ThemeColor('terminal.ansiRed');
      break;
  }
}

// ── Activation ────────────────────────────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  console.log('Bounded extension activated');

  // ── 1. Register sidebar WebView provider FIRST — before any await ─────────
  // VS Code may call resolveWebviewView as soon as the activation event fires.
  // Registering here (synchronously) guarantees the provider exists in time.
  const sidebarPanel = new SidebarPanel(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarPanel.viewType,
      sidebarPanel,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── 2. Recover persisted BRI state (NF-11) ────────────────────────────────
  const recoveredState = await readBRIState(context);
  console.log(
    `Bounded: Recovered BRI state — score: ${recoveredState.currentBRI}, mode: ${recoveredState.activeMode}`
  );

  // ── 3. Business layer ─────────────────────────────────────────────────────
  // Read mode from VS Code settings — this is where onboarding and toggleMode persist it.
  const configMode = vscode.workspace.getConfiguration().get<BoundedMode>('bounded.mode', 'Standard');
  const modeManager      = new ModeManager(configMode);
  // BRI is per-session (FR-03) — always start fresh at 0.
  const briCalculator    = new BRICalculator(0);
  const sessionTracker   = new SessionTracker();
  const reportGenerator  = new ReportGenerator(sessionTracker, briCalculator, modeManager);

  // ── 4. Status bar ─────────────────────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  updateStatusBar(
    statusBar,
    recoveredState.currentBRI,
    recoveredState.stateLabel,
    modeManager.getMode()
  );
  statusBar.tooltip = 'Bounded — Behavioral Reliance Index';
  statusBar.command = 'bounded.openDashboard';
  statusBar.show();
  // TODO: Phase 7 — move status bar management into statusBarItem.ts presenter

  /** Convenience: builds the full BRIState snapshot from all live sources. */
  function currentState(): BRIState {
    return {
      currentBRI: briCalculator.getCurrentBRI(),
      stateLabel: briCalculator.getStateLabel(),
      activeMode: modeManager.getMode(),
      lastSaved: new Date().toISOString(),
      sessionSnapshot: sessionTracker.getSnapshot(),
    };
  }

  // ── 5. Alert controller ───────────────────────────────────────────────────
  const alertController = new AlertController(
    modeManager,
    (label: BRIStateLabel) => {
      // TODO: Phase 6 — replace with dismissible inline alert banner (NF-03)
      console.log(`Bounded: ALERT — BRI state is now ${label}`);
      // NF-06: neutral language only — no punishment words
      vscode.window
        .showWarningMessage(
          `Bounded: Your reliance index is ${label}. Consider writing the next block yourself.`,
          'Dismiss',
          'Open Dashboard'
        )
        .then((selection) => {
          if (selection === 'Open Dashboard') {
            vscode.commands.executeCommand('bounded.openDashboard');
          }
        });
    }
  );

  // ── 6. Event listener with fully wired callbacks ──────────────────────────
  const eventListener = new EventListenerModule(
    context,

    // onPasteDetected — external paste confirmed
    (event: BehavioralEvent) => {
      // Log metadata only — never log content (FR-10)
      console.log(
        `Bounded: paste detected — lines: ${event.lineCount}, internal: ${event.isInternal}`
      );
      sessionTracker.recordPaste(event);
      const updatedState = briCalculator.processPaste(
        event,
        modeManager.getMode(),
        sessionTracker.getSnapshot()
      );
      sessionTracker.updateBRIDelta(
        briCalculator.getCurrentBRI(),
        0
      );
      alertController.check(updatedState.stateLabel);
      updateStatusBar(
        statusBar,
        briCalculator.getCurrentBRI(),
        briCalculator.getStateLabel(),
        modeManager.getMode()
      );
      sidebarPanel.updateState(currentState());
      // TODO: Phase 7 — push live BRI delta to open dashboard via postMessage
    },

    // onUndoDetected — a previous external paste was reversed (FR-06)
    (eventId: string, lineCount: number) => {
      console.log(`Bounded: undo detected — eventId: ${eventId}`);
      sessionTracker.recordUndo(eventId, lineCount);
      const updatedState = briCalculator.processUndo(
        eventId,
        modeManager.getMode(),
        sessionTracker.getSnapshot()
      );
      sessionTracker.updateBRIDelta(
        briCalculator.getCurrentBRI(),
        0
      );
      alertController.check(updatedState.stateLabel);
      updateStatusBar(
        statusBar,
        briCalculator.getCurrentBRI(),
        briCalculator.getStateLabel(),
        modeManager.getMode()
      );
      sidebarPanel.updateState(currentState());
      // TODO: Phase 7 — push live BRI delta to open dashboard via postMessage
    },

    // onModificationDetected - a pasted block was edited after insertion (FR-05)
    (
      eventId: string,
      modificationDepth: number,
      insertedLinesRemoved: number,
      projectLineCount: number
    ) => {
      console.log(
        `Bounded: paste modified - eventId: ${eventId}, depth: ${modificationDepth.toFixed(2)}`
      );
      sessionTracker.recordInsertedLineRemoval(eventId, insertedLinesRemoved);
      const updatedState = briCalculator.processModification(
        eventId,
        modificationDepth,
        modeManager.getMode(),
        sessionTracker.getSnapshot(),
        projectLineCount
      );
      sessionTracker.updateBRIDelta(
        briCalculator.getCurrentBRI(),
        0
      );
      alertController.check(updatedState.stateLabel);
      updateStatusBar(
        statusBar,
        briCalculator.getCurrentBRI(),
        briCalculator.getStateLabel(),
        modeManager.getMode()
      );
      sidebarPanel.updateState(currentState());
    },

    // onWorkspaceSaved - assembles full BRIState and persists to disk (FR-11)
    async () => {
      const state = currentState();
      await writeBRIState(context, state);
      console.log('Bounded: BRI state saved to disk');
      await appendSessionRecord(context, {
        date: new Date().toISOString().split('T')[0],
        finalBRI: briCalculator.getCurrentBRI(),
        linesTyped: sessionTracker.getSnapshot().linesTyped,
        linesPasted: sessionTracker.getSnapshot().linesPasted,
        pasteEventCount: sessionTracker.getSnapshot().pasteEventCount,
        modeActive: modeManager.getMode()
      });
    },

    // onTypingDetected — user pressed Enter or added new lines (not a paste)
    (linesAdded: number) => {
      sessionTracker.recordTyping(linesAdded);
      const updatedState = briCalculator.processSessionActivity(
        modeManager.getMode(),
        sessionTracker.getSnapshot()
      );
      sessionTracker.updateBRIDelta(
        briCalculator.getCurrentBRI(),
        0
      );
      alertController.check(updatedState.stateLabel);
      updateStatusBar(
        statusBar,
        briCalculator.getCurrentBRI(),
        briCalculator.getStateLabel(),
        modeManager.getMode()
      );
      sidebarPanel.updateState(currentState());
    },

    // onFileCleared — document wiped to empty; reset all session counters
    () => {
      sessionTracker.reset();
      briCalculator.reset();
      updateStatusBar(statusBar, 0, 'low', modeManager.getMode());
      sidebarPanel.updateState(currentState());
    }
  );

  eventListener.activate(sessionTracker.getSessionId());
  context.subscriptions.push({ dispose: () => eventListener.dispose() });

  // Push recovered state into the sidebar immediately so it shows the real
  // BRI score rather than the static "0.00 LOW" default from the HTML template.
  sidebarPanel.updateState(currentState());

  // ── Onboarding (Phase 8) ──────────────────────────────────────────────────
  // show() checks isComplete() internally — safe to call on every launch.
  const onboarding = new OnboardingFlow(context);
  onboarding.show();

  // ── Commands ──────────────────────────────────────────────────────────────
  const openDashboard = vscode.commands.registerCommand('bounded.openDashboard', async () => {
    await DashboardPanel.createOrShow(context, reportGenerator);
  });

  const toggleMode = vscode.commands.registerCommand('bounded.toggleMode', async () => {
    const next: BoundedMode =
      modeManager.getMode() === 'Standard' ? 'Strict' : 'Standard';
    modeManager.setMode(next); // takes effect immediately — NF-07
    // Persist to VS Code settings so onboarding and toggleMode stay in sync.
    await vscode.workspace.getConfiguration().update(
      'bounded.mode', next, vscode.ConfigurationTarget.Global
    );
    updateStatusBar(statusBar, briCalculator.getCurrentBRI(), briCalculator.getStateLabel(), next);
    const state = currentState();
    await writeBRIState(context, state);
    sidebarPanel.updateState(state);
    vscode.window.showInformationMessage(`Bounded: Mode switched to ${next}.`);
  });

  const generateReport = vscode.commands.registerCommand('bounded.generateReport', async () => {
    await DashboardPanel.createOrShow(context, reportGenerator);
  });

  // Sync mode changes that originate outside toggleMode (e.g. onboarding completion,
  // manual settings edit). onDidChangeConfiguration fires whenever bounded.mode changes.
  const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('bounded.mode')) {
      const newMode = vscode.workspace.getConfiguration().get<BoundedMode>('bounded.mode', 'Standard');
      modeManager.setMode(newMode);
      updateStatusBar(statusBar, briCalculator.getCurrentBRI(), briCalculator.getStateLabel(), newMode);
      sidebarPanel.updateState(currentState());
    }
  });

  context.subscriptions.push(openDashboard, toggleMode, generateReport, statusBar, configListener);
}

export function deactivate(): void {
  console.log('Bounded extension deactivated');
}
