/**
 * sessionTracker.ts
 * Tracks per-session behavioral statistics entirely in memory.
 * Never reads from or writes to the filesystem — persistence is handled
 * exclusively by briStateStore.ts (data layer).
 *
 * FR-10: No code content is ever stored here — only numeric counters.
 */

import { BehavioralEvent, SessionSnapshot, DEFAULT_BRI_STATE } from '../types';

export class SessionTracker {
  private sessionId: string;
  private snapshot: SessionSnapshot;
  private currentTypingStreak: number = 0;
  private activePasteLineCounts: Map<string, number> = new Map();

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.snapshot = { ...DEFAULT_BRI_STATE.sessionSnapshot };
  }

  /** Records an external insert event. */
  public recordPaste(event: BehavioralEvent): void {
    this.snapshot.linesPasted += event.lineCount;
    this.snapshot.pasteEventCount += 1;
    this.activePasteLineCounts.set(event.eventId, event.lineCount);
    this.currentTypingStreak = 0; // paste breaks the typing streak
  }

  /** Keeps inserted-line display in sync when part of an inserted block is removed. */
  public recordInsertedLineRemoval(eventId: string, lineCount: number): void {
    if (lineCount <= 0) {
      return;
    }

    const currentLineCount = this.activePasteLineCounts.get(eventId) ?? 0;
    const removedLineCount = Math.min(lineCount, currentLineCount);
    if (removedLineCount <= 0) {
      return;
    }

    this.activePasteLineCounts.set(eventId, currentLineCount - removedLineCount);
    this.snapshot.linesPasted = Math.max(0, this.snapshot.linesPasted - removedLineCount);
  }

  /** Records manually typed lines. Increments streak and updates longest if exceeded. */
  public recordTyping(linesChanged: number): void {
    if (linesChanged > 0) {
      this.snapshot.linesTyped     += linesChanged;
      this.currentTypingStreak     += linesChanged;
      if (this.currentTypingStreak > this.snapshot.longestTypingStreak) {
        this.snapshot.longestTypingStreak = this.currentTypingStreak;
      }
    } else if (linesChanged < 0) {
      this.snapshot.linesTyped     = Math.max(0, this.snapshot.linesTyped + linesChanged);
      this.currentTypingStreak     = Math.max(0, this.currentTypingStreak + linesChanged);
    }
  }

  /**
   * Records that a paste was undone (FR-06).
   * Decrements pasteEventCount, floored at 0.
   * Does not adjust linesTyped or streaks.
   */
  public recordUndo(eventId: string, lineCount: number): void {
    const activeLineCount = this.activePasteLineCounts.get(eventId) ?? lineCount;
    this.snapshot.pasteEventCount  = Math.max(0, this.snapshot.pasteEventCount - 1);
    this.snapshot.linesPasted      = Math.max(0, this.snapshot.linesPasted - activeLineCount);
    this.activePasteLineCounts.delete(eventId);
  }

  /** Updates the BRI delta since session start. */
  public updateBRIDelta(currentBRI: number, startBRI: number): void {
    this.snapshot.briDeltaSinceStart = currentBRI - startBRI;
  }

  /** Returns a shallow copy of the current session snapshot. */
  public getSnapshot(): SessionSnapshot {
    return { ...this.snapshot };
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  /** Resets all counters and generates a new session ID. */
  public reset(): void {
    this.sessionId = `session_${Date.now()}`;
    this.snapshot = { ...DEFAULT_BRI_STATE.sessionSnapshot };
    this.currentTypingStreak = 0;
    this.activePasteLineCounts.clear();
  }
}
