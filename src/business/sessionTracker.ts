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

  constructor() {
    this.sessionId = `session_${Date.now()}`;
    this.snapshot = { ...DEFAULT_BRI_STATE.sessionSnapshot };
  }

  /**
   * Records an external paste event.
   * Must only be called for EXTERNAL pastes (isInternal === false).
   * FR-05: Unmodified pastes (modificationDepth === 0) increment unmodifiedPastes.
   */
  public recordPaste(event: BehavioralEvent): void {
    this.snapshot.linesPasted += event.lineCount;
    this.snapshot.pasteEventCount += 1;
    if (event.modificationDepth === 0) {
      this.snapshot.unmodifiedPastes += 1;
    }
    this.currentTypingStreak = 0; // paste breaks the typing streak
  }

  /**
   * Records manually typed lines.
   * Increments the typing streak and updates the longest streak if exceeded.
   * TODO: Phase 4 — wired from EventListener's typing-change detection
   */
  public recordTyping(linesTyped: number): void {
    this.snapshot.linesTyped += linesTyped;
    this.currentTypingStreak += linesTyped;
    if (this.currentTypingStreak > this.snapshot.longestTypingStreak) {
      this.snapshot.longestTypingStreak = this.currentTypingStreak;
    }
  }

  /**
   * Records that a paste was undone (FR-06).
   * Decrements pasteEventCount, floored at 0.
   * Does not adjust linesTyped or streaks.
   */
  public recordUndo(): void {
    this.snapshot.pasteEventCount = Math.max(0, this.snapshot.pasteEventCount - 1);
  }

  /**
   * Updates the BRI delta since session start.
   * TODO: Phase 4 — called by BRI Calculator after every BRI update
   */
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

  /**
   * Resets all counters and generates a new session ID.
   * Called when starting a fresh session (e.g., after report generation).
   * TODO: Phase 7 — invoked by ReportGenerator after session is finalised
   */
  public reset(): void {
    this.sessionId = `session_${Date.now()}`;
    this.snapshot = { ...DEFAULT_BRI_STATE.sessionSnapshot };
    this.currentTypingStreak = 0;
  }
}
