/**
 * eventListener.ts
 * Registers all VS Code editor event listeners and routes events to callbacks
 * via dependency injection. This module owns no business logic — it delegates
 * paste classification to pasteClassifier.ts and notifies callers through
 * the callbacks provided at construction time.
 *
 * NF-01: The onDidChangeTextDocument handler is synchronous. No awaits inside.
 *        Any async follow-up work is wrapped in setImmediate.
 */

import * as vscode from 'vscode';
import { BehavioralEvent } from '../types';
import { classifyPasteEvent } from './pasteClassifier';

/** Maximum number of paste events held in memory for undo matching. */
const RECENT_PASTE_WINDOW = 20;

export class EventListenerModule {
  /** Rolling window of the last RECENT_PASTE_WINDOW external paste events. */
  private recentPastes: BehavioralEvent[] = [];
  private sessionId: string = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onPasteDetected: (event: BehavioralEvent) => void,
    private readonly onUndoDetected: (eventId: string) => void,
    private readonly onWorkspaceSaved: () => void
  ) {}

  /**
   * Registers all listeners and begins monitoring editor events.
   * Disposables are pushed to context.subscriptions so VS Code cleans them up.
   */
  public activate(sessionId: string): void {
    this.sessionId = sessionId;

    // ── Text document changes (paste + undo detection) ──────────────────────
    // Handler MUST remain synchronous — NF-01
    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }

      // ── Paste detection ──────────────────────────────────────────────────
      const pasteEvent = classifyPasteEvent(e, this.sessionId);
      if (pasteEvent !== null) {
        if (pasteEvent.isInternal) {
          // FR-04: internal paste — log silently, no BRI change
          console.log(
            `Bounded: internal paste ignored — lines: ${pasteEvent.lineCount}`
          );
        } else {
          // Track in rolling window for undo matching
          this.recentPastes.push(pasteEvent);
          if (this.recentPastes.length > RECENT_PASTE_WINDOW) {
            this.recentPastes.shift();
          }
          // Async callback is safe here — classification itself was synchronous
          setImmediate(() => this.onPasteDetected(pasteEvent));
        }
        return; // a paste and an undo cannot be the same change
      }

      // ── Undo detection ───────────────────────────────────────────────────
      // An undo of a paste appears as a single pure deletion (no insertion).
      if (e.contentChanges.length === 1) {
        const c = e.contentChanges[0];
        if (c.text === '' && c.rangeLength > 0) {
          const deletedLines = c.range.end.line - c.range.start.line;
          const matchIdx = this.recentPastes.findIndex(
            (p) => p.lineCount === deletedLines
          );
          if (matchIdx !== -1) {
            const [matched] = this.recentPastes.splice(matchIdx, 1);
            setImmediate(() => this.onUndoDetected(matched.eventId));
          }
        }
      }
    });

    // ── Workspace save ───────────────────────────────────────────────────────
    const saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this.onWorkspaceSaved();
    });

    this.context.subscriptions.push(changeListener, saveListener);

    // TODO: Phase 5 — register onDidChangeConfiguration to detect mode changes
  }

  /**
   * Clears the in-memory paste window.
   * VS Code disposes the registered listeners automatically via subscriptions.
   */
  public dispose(): void {
    this.recentPastes = [];
  }
}
