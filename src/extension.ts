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
  item.text = `$(pulse) BRI: ${bri.toFixed(2)} | ${mode}`;
  switch (label) {
    case 'low':
      item.color = new vscode.ThemeColor('terminal.ansiGreen');
      break;
    case 'moderate':
      item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
      break;
    case 'severe':
      item.color = new vscode.ThemeColor('statusBarItem.errorForeground');
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
  const modeManager      = new ModeManager(recoveredState.activeMode);
  const briCalculator    = new BRICalculator(recoveredState.currentBRI);
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
      const updatedState = briCalculator.processPaste(event);
      sessionTracker.updateBRIDelta(
        briCalculator.getCurrentBRI(),
        recoveredState.currentBRI
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
    (eventId: string) => {
      console.log(`Bounded: undo detected — eventId: ${eventId}`);
      sessionTracker.recordUndo();
      const updatedState = briCalculator.processUndo(eventId);
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

    // onWorkspaceSaved — assembles full BRIState and persists to disk (FR-11)
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
    updateStatusBar(statusBar, briCalculator.getCurrentBRI(), briCalculator.getStateLabel(), next);
    const state = currentState();
    await writeBRIState(context, state);
    sidebarPanel.updateState(state);
    vscode.window.showInformationMessage(`Bounded: Mode switched to ${next}.`);
    // TODO: Phase 7 — push mode change to open dashboard via postMessage
  });

  const generateReport = vscode.commands.registerCommand('bounded.generateReport', async () => {
    await DashboardPanel.createOrShow(context, reportGenerator);
  });

  context.subscriptions.push(openDashboard, toggleMode, generateReport, statusBar);
}

export function deactivate(): void {
  console.log('Bounded extension deactivated');
}
