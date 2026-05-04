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
import { classifyPasteEvent, containsInsertedCode } from './pasteClassifier';

/** Maximum number of inserted-code events held in memory for undo/modification matching. */
const RECENT_PASTE_WINDOW = 20;
const RECENT_REMOVAL_WINDOW = 50;
const RECENT_REMOVAL_TTL_MS = 5 * 60 * 1000;
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
  removedLineCount: number;
}

interface RecentRemoval {
  text: string;
  removedAtMs: number;
}

export class EventListenerModule {
  private recentPastes: TrackedPaste[] = [];
  private neutralInsertRanges: TrackedRange[] = [];
  private recentRemovals: RecentRemoval[] = [];
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
      modificationDepth: number,
      insertedLinesRemoved: number,
      projectLineCount: number
    ) => void,
    private readonly onWorkspaceSaved: () => void,
    private readonly onTypingDetected: (linesAdded: number) => void,
    private readonly onFileCleared: () => void
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
      this.pruneRecentRemovals();
      const isUndoOrRedo = this.isUndoOrRedoChange(e);
      const restoredRecentRemoval =
        isUndoOrRedo && this.isRecentRemovalRestore(e.contentChanges);
      const internalSourceTexts = Array.from(this.workspaceTextCache.entries())
        .filter(([key]) => key !== documentKey)
        .map(([, text]) => text)
        .concat(isUndoOrRedo ? this.recentRemovals.map((removal) => removal.text) : []);
      const minInsertedLines = this.isLikelyAgentInsert(e.contentChanges) ? 1 : undefined;
      const pasteEvent = classifyPasteEvent(
        e,
        this.sessionId,
        previousDocumentText,
        internalSourceTexts,
        { minInsertedLines }
      );
      if (pasteEvent !== null) {
        const currentLines = this.snapshotLines(e.document);
        const netLineDelta =
          this.countNonEmptyLines(currentLines) - this.countNonEmptyLines(previousLines);
        pasteEvent.projectLineCount = this.countProjectNonEmptyLines(
          documentKey,
          e.document.getText()
        );
        this.documentLineSnapshots.set(documentKey, currentLines);
        this.workspaceTextCache.set(documentKey, e.document.getText());

        if (pasteEvent.isInternal) {
          if (restoredRecentRemoval && netLineDelta !== 0) {
            setImmediate(() => this.onTypingDetected(netLineDelta));
            this.removeRestoredRecentRemovals(e.contentChanges);
          } else {
            this.trackNeutralInsertRanges(e.contentChanges);
          }
          console.log(`Bounded: internal insert ignored - lines: ${pasteEvent.lineCount}`);
        } else if (!this.workspaceTextCacheReady) {
          this.trackNeutralInsertRanges(e.contentChanges);
          console.log(`Bounded: insert ignored while workspace cache is warming - lines: ${pasteEvent.lineCount}`);
        } else {
          const ranges = e.contentChanges
            .filter((change) => change.text.trim() !== '')
            .map((change) => ({
              startLine: change.range.start.line,
              endLine: change.range.start.line + change.text.split('\n').length - 1,
              modifiedLines: new Set<number>(),
            }));

          this.recentPastes.push({ event: pasteEvent, ranges, removedLineCount: 0 });
          if (this.recentPastes.length > RECENT_PASTE_WINDOW) {
            this.recentPastes.shift();
          }
          setImmediate(() => this.onPasteDetected(pasteEvent));
        }
        return;
      }

      const handledByInsertTracking = new Set<number>();
      const insertedLinesRemovedPerChange = new Map<number, number>();

      for (let ci = 0; ci < e.contentChanges.length; ci++) {
        const c = e.contentChanges[ci];
        const changeStart = c.range.start.line;
        const changeEnd = c.range.end.line;
        const addedLines = c.text === '' ? 0 : c.text.split('\n').length - 1;
        const lineDelta = addedLines - (changeEnd - changeStart);

        for (let i = this.recentPastes.length - 1; i >= 0; i--) {
          const tracked = this.recentPastes[i];
          let modified = false;
          let insertedLinesRemoved = 0;

          for (let ri = tracked.ranges.length - 1; ri >= 0; ri--) {
            const range = tracked.ranges[ri];

            if (
              c.text.trim() === '' &&
              !c.range.isEmpty &&
              this.changeCoversTrackedRange(c, range)
            ) {
              const removedLineCount = this.getRemovedNonEmptyLineCount(
                previousLines,
                c.range
              );
              insertedLinesRemoved += removedLineCount;
              modified = removedLineCount > 0;
              tracked.ranges.splice(ri, 1);
              handledByInsertTracking.add(ci);
              continue;
            }

            if (c.text.trim() === '') {
              if (this.changeIsBeforeTrackedRange(c, range)) {
                range.startLine += lineDelta;
                range.endLine += lineDelta;
              } else if (this.changeTouchesTrackedRange(c, range)) {
                handledByInsertTracking.add(ci);
                const removedText = this.getTextFromPreviousRange(previousLines, c.range);
                if (removedText.trim() !== '') {
                  modified = true;
                  const touchedStart = Math.max(changeStart, range.startLine);
                  const touchedEnd = Math.min(
                    Math.max(changeEnd, changeStart),
                    range.endLine
                  );
                  for (let line = touchedStart; line <= touchedEnd; line++) {
                    range.modifiedLines.add(line);
                  }
                }
                const removedLineCount = Math.min(
                  this.getRemovedNonEmptyLineCount(previousLines, c.range),
                  tracked.event.lineCount - tracked.removedLineCount
                );
                if (removedLineCount > 0) {
                  modified = true;
                  insertedLinesRemoved += removedLineCount;
                }
                this.adjustRangeForWhitespaceChange(c, range, lineDelta);
              }
              continue;
            }

            if (this.isManualNonEmptyInsertOnEmptyLine(c, previousLines)) {
              continue;
            }

            if (this.changeTouchesTrackedRange(c, range)) {
              handledByInsertTracking.add(ci);
              modified = true;
              const touchedStart = Math.max(changeStart, range.startLine);
              const touchedEnd = Math.min(Math.max(changeEnd, changeStart), range.endLine);
              for (let line = touchedStart; line <= touchedEnd; line++) {
                range.modifiedLines.add(line);
              }
              if (changeStart < range.startLine) {
                range.startLine += lineDelta;
              }
              range.endLine = Math.max(range.startLine, range.endLine + lineDelta);
              continue;
            }

            if (this.changeIsBeforeTrackedRange(c, range)) {
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
            tracked.removedLineCount += insertedLinesRemoved;
            const modifiedLineCount = tracked.ranges.reduce(
              (sum, range) => sum + range.modifiedLines.size,
              tracked.removedLineCount
            );
            const modificationDepth = Math.min(
              1,
              modifiedLineCount / Math.max(1, tracked.event.lineCount)
            );
            tracked.event.modificationDepth = modificationDepth;
            if (insertedLinesRemoved > 0) {
              insertedLinesRemovedPerChange.set(
                ci,
                (insertedLinesRemovedPerChange.get(ci) ?? 0) + insertedLinesRemoved
              );
            }
            setImmediate(() =>
              this.onModificationDetected(
                tracked.event.eventId,
                modificationDepth,
                insertedLinesRemoved,
                this.countProjectNonEmptyLines(documentKey, e.document.getText())
              )
            );
          }
        }

        this.updateNeutralInsertRanges(
          c,
          ci,
          previousLines,
          lineDelta,
          handledByInsertTracking
        );
      }

      this.trackRemovedText(e.contentChanges, previousLines, handledByInsertTracking);

      const currentLines = this.snapshotLines(e.document);

      const wasNonEmpty = this.countNonEmptyLines(previousLines) > 0;
      const isNowEmpty = this.countNonEmptyLines(currentLines) === 0;
      if (wasNonEmpty && isNowEmpty) {
        this.recentPastes = [];
        this.neutralInsertRanges = [];
        this.documentLineSnapshots.set(documentKey, currentLines);
        this.workspaceTextCache.set(documentKey, e.document.getText());
        setImmediate(() => this.onFileCleared());
        return;
      }

      const netLineDelta = this.calculateTypedLineDelta(
        e.contentChanges,
        previousLines,
        currentLines,
        handledByInsertTracking,
        insertedLinesRemovedPerChange
      );
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
    this.neutralInsertRanges = [];
    this.recentRemovals = [];
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

  private countNonEmptyLines(lines: readonly string[]): number {
    return lines.filter((line) => line.trim() !== '').length;
  }

  private countProjectNonEmptyLines(currentDocumentKey: string, currentDocumentText: string): number {
    let total = this.countNonEmptyLines(currentDocumentText.split('\n'));
    for (const [key, text] of this.workspaceTextCache.entries()) {
      if (key !== currentDocumentKey) {
        total += this.countNonEmptyLines(text.split('\n'));
      }
    }
    return total;
  }

  private calculateTypedLineDelta(
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    previousLines: readonly string[],
    currentLines: readonly string[],
    handledChangeIndices: ReadonlySet<number>,
    insertedLinesRemovedPerChange: ReadonlyMap<number, number> = new Map()
  ): number {
    if (handledChangeIndices.size === 0) {
      return this.countNonEmptyLines(currentLines) - this.countNonEmptyLines(previousLines);
    }

    return changes.reduce((delta, change, index) => {
      if (!handledChangeIndices.has(index)) {
        return delta + this.calculateSingleChangeLineDelta(change, previousLines);
      }
      // For changes that touched an inserted range, compute the typed portion:
      // total line delta minus the inserted lines already accounted for by recordInsertedLineRemoval.
      const changeLineDelta = this.calculateSingleChangeLineDelta(change, previousLines);
      const insertedRemoved = insertedLinesRemovedPerChange.get(index) ?? 0;
      return delta + changeLineDelta + insertedRemoved;
    }, 0);
  }

  private calculateSingleChangeLineDelta(
    change: vscode.TextDocumentContentChangeEvent,
    previousLines: readonly string[]
  ): number {
    const previousText = previousLines.join('\n');
    const startOffset = this.offsetAt(previousLines, change.range.start);
    const endOffset = this.offsetAt(previousLines, change.range.end);
    const updatedText =
      previousText.slice(0, startOffset) + change.text + previousText.slice(endOffset);

    return (
      this.countNonEmptyLines(updatedText.split('\n')) -
      this.countNonEmptyLines(previousLines)
    );
  }

  private trackNeutralInsertRanges(
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): void {
    const ranges = changes
      .filter((change) => change.text.trim() !== '')
      .map((change) => ({
        startLine: change.range.start.line,
        endLine: change.range.start.line + change.text.split('\n').length - 1,
        modifiedLines: new Set<number>(),
      }));

    this.neutralInsertRanges.push(...ranges);
    if (this.neutralInsertRanges.length > RECENT_PASTE_WINDOW * 2) {
      this.neutralInsertRanges = this.neutralInsertRanges.slice(-(RECENT_PASTE_WINDOW * 2));
    }
  }

  private updateNeutralInsertRanges(
    change: vscode.TextDocumentContentChangeEvent,
    changeIndex: number,
    previousLines: readonly string[],
    lineDelta: number,
    handledChangeIndices: Set<number>
  ): void {
    if (handledChangeIndices.has(changeIndex)) {
      return;
    }

    for (let ri = this.neutralInsertRanges.length - 1; ri >= 0; ri--) {
      const range = this.neutralInsertRanges[ri];

      if (
        change.text.trim() === '' &&
        !change.range.isEmpty &&
        this.changeCoversTrackedRange(change, range)
      ) {
        this.neutralInsertRanges.splice(ri, 1);
        handledChangeIndices.add(changeIndex);
        continue;
      }

      if (change.text.trim() === '') {
        if (this.changeIsBeforeTrackedRange(change, range)) {
          range.startLine += lineDelta;
          range.endLine += lineDelta;
        } else if (this.changeTouchesTrackedRange(change, range)) {
          handledChangeIndices.add(changeIndex);
          this.adjustRangeForWhitespaceChange(change, range, lineDelta);
        }
        continue;
      }

      if (this.isManualNonEmptyInsertOnEmptyLine(change, previousLines)) {
        continue;
      }

      if (this.changeTouchesTrackedRange(change, range)) {
        handledChangeIndices.add(changeIndex);
        if (change.range.start.line < range.startLine) {
          range.startLine += lineDelta;
        }
        range.endLine = Math.max(range.startLine, range.endLine + lineDelta);
        continue;
      }

      if (this.changeIsBeforeTrackedRange(change, range)) {
        range.startLine += lineDelta;
        range.endLine += lineDelta;
      }
    }
  }

  private adjustRangeForWhitespaceChange(
    change: vscode.TextDocumentContentChangeEvent,
    range: TrackedRange,
    lineDelta: number
  ): void {
    if (lineDelta <= 0) {
      range.endLine = Math.max(range.startLine, range.endLine + lineDelta);
      return;
    }

    const addsLineAtRangeEnd =
      change.range.isEmpty && change.range.start.line >= range.endLine;
    if (!addsLineAtRangeEnd) {
      range.endLine = Math.max(range.startLine, range.endLine + lineDelta);
    }
  }

  private isManualNonEmptyInsertOnEmptyLine(
    change: vscode.TextDocumentContentChangeEvent,
    previousLines: readonly string[]
  ): boolean {
    if (!change.range.isEmpty || change.text.trim() === '') {
      return false;
    }

    const previousLine = previousLines[change.range.start.line] ?? '';
    return previousLine.trim() === '';
  }

  private getTrackedRangeLineCount(range: TrackedRange): number {
    return Math.max(0, range.endLine - range.startLine + 1);
  }

  private getRemovedNonEmptyLineCount(
    previousLines: readonly string[],
    range: vscode.Range
  ): number {
    // Intra-line deletion (backspace/delete on chars within one line) never removes a whole line.
    if (range.start.line === range.end.line) {
      return 0;
    }
    const removedText = this.getTextFromPreviousRange(previousLines, range);
    const nonEmptyCount = this.countNonEmptyLines(removedText.split('\n'));
    // When the removed text is only whitespace/newlines (e.g. merging two lines via
    // backspace at col 0), nonEmptyCount is 0 but one line boundary was still crossed.
    return Math.max(nonEmptyCount, range.end.line - range.start.line);
  }

  private changeTouchesTrackedRange(
    change: vscode.TextDocumentContentChangeEvent,
    range: TrackedRange
  ): boolean {
    if (change.range.isEmpty) {
      return (
        change.range.start.line >= range.startLine &&
        change.range.start.line <= range.endLine
      );
    }

    const changeStart = change.range.start.line;
    const changeEndExclusive = this.getChangeEndLineExclusive(change);
    const rangeEndExclusive = range.endLine + 1;
    return changeStart < rangeEndExclusive && changeEndExclusive > range.startLine;
  }

  private changeCoversTrackedRange(
    change: vscode.TextDocumentContentChangeEvent,
    range: TrackedRange
  ): boolean {
    if (change.range.isEmpty) {
      return false;
    }

    const startsAtRangeLineStart =
      change.range.start.line < range.startLine || change.range.start.character === 0;
    const endsAfterRangeLine =
      change.range.end.line > range.endLine || change.range.end.character === 0;

    return (
      change.range.start.line <= range.startLine &&
      startsAtRangeLineStart &&
      this.getChangeEndLineExclusive(change) >= range.endLine + 1 &&
      endsAfterRangeLine
    );
  }

  private changeIsBeforeTrackedRange(
    change: vscode.TextDocumentContentChangeEvent,
    range: TrackedRange
  ): boolean {
    if (change.range.isEmpty) {
      return change.range.start.line < range.startLine;
    }

    return this.getChangeEndLineExclusive(change) <= range.startLine;
  }

  private getChangeEndLineExclusive(
    change: vscode.TextDocumentContentChangeEvent
  ): number {
    if (change.range.isEmpty) {
      return change.range.end.line;
    }

    return change.range.end.character === 0
      ? change.range.end.line
      : change.range.end.line + 1;
  }

  private isUndoOrRedoChange(event: vscode.TextDocumentChangeEvent): boolean {
    return (
      event.reason === vscode.TextDocumentChangeReason.Undo ||
      event.reason === vscode.TextDocumentChangeReason.Redo
    );
  }

  private isLikelyAgentInsert(
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): boolean {
    const insertedTexts = changes
      .map((change) => change.text)
      .filter((text) => text.trim() !== '');

    if (insertedTexts.length === 0) {
      return false;
    }

    return changes.length > 1;
  }

  private trackRemovedText(
    changes: readonly vscode.TextDocumentContentChangeEvent[],
    previousLines: readonly string[],
    handledChangeIndices: ReadonlySet<number> = new Set()
  ): void {
    this.pruneRecentRemovals();

    for (let index = 0; index < changes.length; index++) {
      if (handledChangeIndices.has(index)) {
        continue;
      }

      const change = changes[index];
      if (change.range.isEmpty) {
        continue;
      }

      const removedText = this.getTextFromPreviousRange(previousLines, change.range);
      if (this.countNonEmptyLines(removedText.split('\n')) < 3) {
        continue;
      }

      this.recentRemovals.push({
        text: removedText,
        removedAtMs: Date.now(),
      });
    }

    if (this.recentRemovals.length > RECENT_REMOVAL_WINDOW) {
      this.recentRemovals = this.recentRemovals.slice(-RECENT_REMOVAL_WINDOW);
    }
  }

  private pruneRecentRemovals(): void {
    const cutoff = Date.now() - RECENT_REMOVAL_TTL_MS;
    this.recentRemovals = this.recentRemovals.filter(
      (removal) => removal.removedAtMs >= cutoff
    );
  }

  private getTextFromPreviousRange(
    previousLines: readonly string[],
    range: vscode.Range
  ): string {
    const previousText = previousLines.join('\n');
    const startOffset = this.offsetAt(previousLines, range.start);
    const endOffset = this.offsetAt(previousLines, range.end);
    return previousText.slice(startOffset, endOffset);
  }

  private offsetAt(lines: readonly string[], position: vscode.Position): number {
    let offset = 0;
    const targetLine = Math.min(position.line, lines.length - 1);
    for (let i = 0; i < targetLine; i++) {
      offset += lines[i].length + 1;
    }

    const lineText = lines[targetLine] ?? '';
    return offset + Math.min(position.character, lineText.length);
  }

  private isRecentRemovalRestore(
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): boolean {
    const insertedTexts = changes
      .map((change) => change.text)
      .filter((text) => text.trim() !== '');

    if (insertedTexts.length === 0 || this.recentRemovals.length === 0) {
      return false;
    }

    return insertedTexts.every((insertedText) =>
      this.recentRemovals.some((removal) =>
        containsInsertedCode(removal.text, insertedText)
      )
    );
  }

  private removeRestoredRecentRemovals(
    changes: readonly vscode.TextDocumentContentChangeEvent[]
  ): void {
    const insertedTexts = changes
      .map((change) => change.text)
      .filter((text) => text.trim() !== '');

    this.recentRemovals = this.recentRemovals.filter(
      (removal) =>
        !insertedTexts.some((insertedText) =>
          containsInsertedCode(removal.text, insertedText)
        )
    );
  }
}
