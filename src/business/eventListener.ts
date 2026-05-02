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

/** Maximum number of paste events held in memory for undo/modification matching. */
const RECENT_PASTE_WINDOW = 20;

/**
 * A paste event enriched with its document position (metadata only — no content).
 * startLine/endLine let us match undos and modifications by range instead of
 * relying on fragile line-count comparisons.
 */
interface TrackedPaste {
  event: BehavioralEvent;
  startLine: number;
  endLine: number;
}

export class EventListenerModule {
  /** Rolling window of the last RECENT_PASTE_WINDOW external paste events. */
  private recentPastes: TrackedPaste[] = [];
  private sessionId: string = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onPasteDetected: (event: BehavioralEvent) => void,
    private readonly onUndoDetected: (eventId: string) => void,
    private readonly onWorkspaceSaved: () => void,
    private readonly onTypingDetected: (linesAdded: number) => void
  ) {}

  /**
   * Registers all listeners and begins monitoring editor events.
   * Disposables are pushed to context.subscriptions so VS Code cleans them up.
   */
  public activate(sessionId: string): void {
    this.sessionId = sessionId;

    // ── Text document changes ───────────────────────────────────────────────
    // Handler MUST remain synchronous — NF-01
    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }

      // Ignore VS Code internal documents (output channels, git diffs, etc.).
      const scheme = e.document.uri.scheme;
      if (scheme !== 'file' && scheme !== 'untitled') {
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
          // Store with its document range so later changes can be matched by position.
          // lineCount = split('\n').length = newlines + 1, so endLine = start + lineCount - 1.
          const c0 = e.contentChanges[0];
          const startLine = c0.range.start.line;
          const endLine   = startLine + pasteEvent.lineCount - 1;
          this.recentPastes.push({ event: pasteEvent, startLine, endLine });
          if (this.recentPastes.length > RECENT_PASTE_WINDOW) {
            this.recentPastes.shift();
          }
          setImmediate(() => this.onPasteDetected(pasteEvent));
        }
        return; // a paste and an undo/edit cannot be the same change
      }

      // ── Undo / modification / shift detection ────────────────────────────
      // Iterate content changes in reverse-index order over recentPastes so that
      // splicing an entry doesn't corrupt unprocessed indices.
      for (const c of e.contentChanges) {
        const changeStart = c.range.start.line;
        const changeEnd   = c.range.end.line;
        const addedLines  = c.text === '' ? 0 : (c.text.split('\n').length - 1);
        const lineDelta   = addedLines - (changeEnd - changeStart);

        for (let i = this.recentPastes.length - 1; i >= 0; i--) {
          const tracked = this.recentPastes[i];

          // ── Undo / erase ────────────────────────────────────────────────
          // The change completely covers the paste's line range.
          // Handles Ctrl+Z (pure deletion) and manual select-all-then-delete,
          // as well as replacement-undos where text !== '' (paste over selection).
          if (changeStart <= tracked.startLine && changeEnd >= tracked.endLine) {
            this.recentPastes.splice(i, 1);
            setImmediate(() => this.onUndoDetected(tracked.event.eventId));
            continue;
          }

          // ── Modification ────────────────────────────────────────────────
          // An insertion lands within the paste's range — the user is actively
          // editing the pasted code, so reverse its BRI contribution (FR-05).
          if (
            c.text !== '' &&
            changeStart >= tracked.startLine &&
            changeStart <= tracked.endLine
          ) {
            this.recentPastes.splice(i, 1);
            setImmediate(() => this.onUndoDetected(tracked.event.eventId));
            continue;
          }

          // ── Line shift ──────────────────────────────────────────────────
          // A change entirely above this paste shifts its tracked position.
          if (changeEnd < tracked.startLine) {
            tracked.startLine += lineDelta;
            tracked.endLine   += lineDelta;
          }
        }
      }

      // ── Typing detection ─────────────────────────────────────────────────
      // Count net new lines added (Enter key = 1 new line).
      // Pure deletions and same-line edits produce 0 and are ignored.
      let newLines = 0;
      for (const c of e.contentChanges) {
        if (c.text.includes('\n')) {
          newLines += c.text.split('\n').length - 1;
        }
      }
      if (newLines > 0) {
        setImmediate(() => this.onTypingDetected(newLines));
      }
    });

    // ── Workspace save ───────────────────────────────────────────────────────
    const saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this.onWorkspaceSaved();
    });

    this.context.subscriptions.push(changeListener, saveListener);
  }

  /**
   * Clears the in-memory paste window.
   * VS Code disposes the registered listeners automatically via subscriptions.
   */
  public dispose(): void {
    this.recentPastes = [];
  }
}
