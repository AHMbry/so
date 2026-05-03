/**
 * eventListener.ts
 * Registers all VS Code editor event listeners and routes events to callbacks
 * via dependency injection. This module owns no business logic; it delegates
 * inserted-code classification to pasteClassifier.ts and notifies callers
 * through the callbacks provided at construction time.
 *
 * NF-01: The onDidChangeTextDocument handler is synchronous. No awaits inside.
 *        Any async follow-up work is wrapped in setImmediate.
 */

import * as vscode from 'vscode';
import { BehavioralEvent } from '../types';
import { classifyPasteEvent } from './pasteClassifier';

/** Maximum number of inserted-code events held in memory for undo/modification matching. */
const RECENT_PASTE_WINDOW = 20;
const MAX_CACHED_FILE_BYTES = 1_000_000;

interface TrackedRange {
  startLine: number;
  endLine: number;
  modifiedLines: Set<number>;
}

/**
 * Inserted-code event enriched with document ranges.
 * Ranges let us track multi-location AI edits without treating everything
 * between the first and last edit as inserted code.
 */
interface TrackedPaste {
  event: BehavioralEvent;
  ranges: TrackedRange[];
}

export class EventListenerModule {
  private recentPastes: TrackedPaste[] = [];
  private documentLineSnapshots: Map<string, string[]> = new Map();
  private workspaceTextCache: Map<string, string> = new Map();
  private workspaceTextCacheReady = false;
  private sessionId: string = '';

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly onPasteDetected: (event: BehavioralEvent) => void,
    private readonly onUndoDetected: (eventId: string, lineCount: number) => void,
    private readonly onModificationDetected: (
      eventId: string,
      modificationDepth: number
    ) => void,
    private readonly onWorkspaceSaved: () => void,
    private readonly onTypingDetected: (linesAdded: number) => void
  ) {}

  public activate(sessionId: string): void {
    this.sessionId = sessionId;
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === 'file' || doc.uri.scheme === 'untitled') {
        this.documentLineSnapshots.set(this.getDocumentKey(doc), this.snapshotLines(doc));
        this.workspaceTextCache.set(this.getDocumentKey(doc), doc.getText());
      }
    }
    this.refreshWorkspaceTextCache();

    const changeListener = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length === 0) {
        return;
      }

      const scheme = e.document.uri.scheme;
      if (scheme !== 'file' && scheme !== 'untitled') {
        return;
      }

      const documentKey = this.getDocumentKey(e.document);
      const previousLines = this.documentLineSnapshots.get(documentKey);
      if (previousLines === undefined) {
        this.documentLineSnapshots.set(documentKey, this.snapshotLines(e.document));
        return;
      }

      const previousDocumentText = previousLines.join('\n');
      const internalSourceTexts = Array.from(this.workspaceTextCache.entries())
        .filter(([key]) => key !== documentKey)
        .map(([, text]) => text);
      const pasteEvent = classifyPasteEvent(
        e,
        this.sessionId,
        previousDocumentText,
        internalSourceTexts
      );
      if (pasteEvent !== null) {
        const currentLines = this.snapshotLines(e.document);
        this.documentLineSnapshots.set(documentKey, currentLines);
        this.workspaceTextCache.set(documentKey, e.document.getText());

        if (pasteEvent.isInternal) {
          console.log(`Bounded: internal insert ignored - lines: ${pasteEvent.lineCount}`);
        } else if (!this.workspaceTextCacheReady) {
          console.log(`Bounded: insert ignored while workspace cache is warming - lines: ${pasteEvent.lineCount}`);
        } else {
          const ranges = e.contentChanges
            .filter((change) => change.text.trim() !== '')
            .map((change) => ({
              startLine: change.range.start.line,
              endLine: change.range.start.line + change.text.split('\n').length - 1,
              modifiedLines: new Set<number>(),
            }));

          this.recentPastes.push({ event: pasteEvent, ranges });
          if (this.recentPastes.length > RECENT_PASTE_WINDOW) {
            this.recentPastes.shift();
          }
          setImmediate(() => this.onPasteDetected(pasteEvent));
        }
        return;
      }

      const consumedByUndo = new Set<number>();

      for (let ci = 0; ci < e.contentChanges.length; ci++) {
        const c = e.contentChanges[ci];
        const changeStart = c.range.start.line;
        const changeEnd = c.range.end.line;
        const addedLines = c.text === '' ? 0 : c.text.split('\n').length - 1;
        const lineDelta = addedLines - (changeEnd - changeStart);

        for (let i = this.recentPastes.length - 1; i >= 0; i--) {
          const tracked = this.recentPastes[i];
          let modified = false;

          for (let ri = tracked.ranges.length - 1; ri >= 0; ri--) {
            const range = tracked.ranges[ri];

            if (changeStart <= range.startLine && changeEnd >= range.endLine) {
              tracked.ranges.splice(ri, 1);
              consumedByUndo.add(ci);
              continue;
            }

            if (c.text !== '' && changeStart <= range.endLine && changeEnd >= range.startLine) {
              consumedByUndo.add(ci);
              modified = true;
              const touchedStart = Math.max(changeStart, range.startLine);
              const touchedEnd = Math.min(Math.max(changeEnd, changeStart), range.endLine);
              for (let line = touchedStart; line <= touchedEnd; line++) {
                range.modifiedLines.add(line);
              }
              continue;
            }

            if (changeEnd < range.startLine) {
              range.startLine += lineDelta;
              range.endLine += lineDelta;
            }
          }

          if (tracked.ranges.length === 0) {
            this.recentPastes.splice(i, 1);
            setImmediate(() => this.onUndoDetected(tracked.event.eventId, tracked.event.lineCount));
            continue;
          }

          if (modified) {
            const modifiedLineCount = tracked.ranges.reduce(
              (sum, range) => sum + range.modifiedLines.size,
              0
            );
            const modificationDepth = Math.min(
              1,
              modifiedLineCount / Math.max(1, tracked.event.lineCount)
            );
            tracked.event.modificationDepth = modificationDepth;
            setImmediate(() =>
              this.onModificationDetected(tracked.event.eventId, modificationDepth)
            );
          }
        }
      }

      const currentLines = this.snapshotLines(e.document);
      const netLineDelta =
        consumedByUndo.size === 0
          ? this.countNonEmptyLines(currentLines) - this.countNonEmptyLines(previousLines)
          : 0;
      this.documentLineSnapshots.set(documentKey, currentLines);
      this.workspaceTextCache.set(documentKey, e.document.getText());
      if (netLineDelta !== 0) {
        setImmediate(() => this.onTypingDetected(netLineDelta));
      }
    });

    const saveListener = vscode.workspace.onDidSaveTextDocument(() => {
      this.onWorkspaceSaved();
    });

    this.context.subscriptions.push(changeListener, saveListener);
  }

  public dispose(): void {
    this.recentPastes = [];
    this.documentLineSnapshots.clear();
    this.workspaceTextCache.clear();
    this.workspaceTextCacheReady = false;
  }

  private refreshWorkspaceTextCache(): void {
    vscode.workspace.findFiles(
      '**/*',
      '**/{.git,node_modules,out,dist,build,.vscode-test}/**'
    ).then(async (uris) => {
      for (const uri of uris) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_CACHED_FILE_BYTES) {
            continue;
          }
          const bytes = await vscode.workspace.fs.readFile(uri);
          this.workspaceTextCache.set(uri.toString(), new TextDecoder('utf-8').decode(bytes));
        } catch {
          // Ignore files that disappear or cannot be decoded; the cache is best-effort.
        }
      }
      this.workspaceTextCacheReady = true;
    }, () => {
      this.workspaceTextCacheReady = true;
    });
  }

  private getDocumentKey(document: vscode.TextDocument): string {
    return document.uri.toString();
  }

  private snapshotLines(document: vscode.TextDocument): string[] {
    const lines: string[] = [];
    for (let i = 0; i < document.lineCount; i++) {
      lines.push(document.lineAt(i).text);
    }
    return lines;
  }

  private countNonEmptyLines(lines: string[]): number {
    return lines.filter((line) => line.trim() !== '').length;
  }
}
