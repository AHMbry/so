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
    private readonly onUndoDetected: (eventId: string, lineCount: number) => void,
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
          // endLine is derived from the raw text span (all lines including blanks),
          // not lineCount (which filters blanks for BRI purposes).
          const c0 = e.contentChanges[0];
          const startLine = c0.range.start.line;
          const endLine   = startLine + c0.text.split('\n').length - 1;
          this.recentPastes.push({ event: pasteEvent, startLine, endLine });
          if (this.recentPastes.length > RECENT_PASTE_WINDOW) {
            this.recentPastes.shift();
          }
          setImmediate(() => this.onPasteDetected(pasteEvent));
        }
        return; // a paste and an undo/edit cannot be the same change
      }

      // ── Undo / modification / shift detection ────────────────────────────
      // consumedByUndo tracks which content-change indices were matched to a
      // paste so the typing detector below does not double-count them.
      const consumedByUndo = new Set<number>();

      for (let ci = 0; ci < e.contentChanges.length; ci++) {
        const c = e.contentChanges[ci];
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
            consumedByUndo.add(ci);
            setImmediate(() => this.onUndoDetected(tracked.event.eventId, tracked.event.lineCount));
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
            consumedByUndo.add(ci);
            setImmediate(() => this.onUndoDetected(tracked.event.eventId, tracked.event.lineCount));
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

      // ── Typing / erase detection ──────────────────────────────────────────
      // Net line delta for changes not consumed by paste undo.
      // Positive = lines typed; negative = lines erased.
      let netLineDelta = 0;
      for (let ci = 0; ci < e.contentChanges.length; ci++) {
        if (consumedByUndo.has(ci)) { continue; }
        const c = e.contentChanges[ci];
        // Count typed lines, excluding blank-line creation:
        //   - Single Enter (parts.length === 2): check whether the line being
        //     completed in the document has content. e.document is post-change,
        //     but the completed line (range.start.line) still holds the text
        //     that was before the cursor.
        //   - Multi-line insertion (snippet/autocomplete): count segments that
        //     contain non-whitespace content.
        let added = 0;
        if (c.text.includes('\n')) {
          const parts = c.text.split('\n');
          if (parts.length === 2) {
            const completedLine = e.document.lineAt(c.range.start.line).text;
            if (completedLine.trim() !== '') { added = 1; }
          } else {
            for (let pi = 0; pi < parts.length - 1; pi++) {
              if (parts[pi + 1].trim() !== '') { added++; }
            }
          }
        }
        const removed = c.range.end.line - c.range.start.line;
        netLineDelta += added - removed;
      }
      if (netLineDelta !== 0) {
        setImmediate(() => this.onTypingDetected(netLineDelta));
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
