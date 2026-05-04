/**
 * briCalculator.ts
 * Core BRI computation module. Maintains the current BRI score in memory,
 * applies increase/decrease rules per event, and derives the state label.
 *
 * FR-10: No code content is ever stored here. Only numeric counters,
 * timestamps, event IDs, and contribution scores are retained.
 */

import {
  BehavioralEvent,
  BRIState,
  BRIStateLabel,
  BoundedMode,
  SessionSnapshot,
} from '../types';

interface PasteContribution {
  lineCount: number;
  projectLineCount: number;
  baseContribution: number;
  currentContribution: number;
  rawModificationDepth: number;
  effectiveModificationDepth: number;
  occurredAtMs: number;
}

const MIN_BRI_WITH_ACTIVE_PASTE = 0.05;

export class BRICalculator {
  private currentBRI: number;
  private startBRI: number;
  /** Maps eventId -> contribution metadata so edits and undos adjust exact deltas. */
  private contributions: Map<string, PasteContribution> = new Map();

  constructor(initialBRI: number) {
    this.currentBRI = this.clampAndRound(initialBRI);
    this.startBRI = this.currentBRI;
  }

  /**
   * Applies BRI increase rules for an external paste event.
   * Internal pastes are silently ignored (FR-04).
   */
  public processPaste(
    event: BehavioralEvent,
    activeMode: BoundedMode,
    sessionSnapshot: SessionSnapshot
  ): BRIState {
    if (!event.isInternal && event.lineCount >= 3) {
      const baseContribution = Math.min(0.08 + event.lineCount * 0.01, 0.20);
      const rawModificationDepth = this.clamp01(event.modificationDepth);
      const projectLineCount = Math.max(
        event.lineCount,
        event.projectLineCount ?? this.estimateProjectLineCount(sessionSnapshot, event.lineCount)
      );
      const effectiveModificationDepth = this.calculateEffectiveModificationDepth(
        rawModificationDepth,
        event.lineCount,
        projectLineCount
      );
      this.contributions.set(event.eventId, {
        lineCount: event.lineCount,
        projectLineCount,
        baseContribution,
        currentContribution: baseContribution * (1 - effectiveModificationDepth),
        rawModificationDepth,
        effectiveModificationDepth,
        occurredAtMs: this.parseEventTime(event.occurredAt),
      });
    }

    return this.recalculate(activeMode, sessionSnapshot);
  }

  /**
   * Applies a graded reduction when a user edits a pasted block.
   * modificationDepth is 0.0-1.0 where 1.0 means the paste contributes nothing.
   */
  public processModification(
    eventId: string,
    modificationDepth: number,
    activeMode: BoundedMode,
    sessionSnapshot: SessionSnapshot,
    projectLineCount?: number
  ): BRIState {
    const contribution = this.contributions.get(eventId);
    if (contribution !== undefined) {
      contribution.rawModificationDepth = Math.max(
        contribution.rawModificationDepth,
        this.clamp01(modificationDepth)
      );
      contribution.projectLineCount = Math.max(
        contribution.lineCount,
        projectLineCount ??
          contribution.projectLineCount ??
          this.estimateProjectLineCount(sessionSnapshot, contribution.lineCount)
      );
      contribution.effectiveModificationDepth = this.calculateEffectiveModificationDepth(
        contribution.rawModificationDepth,
        contribution.lineCount,
        contribution.projectLineCount
      );
      contribution.currentContribution =
        contribution.baseContribution * (1 - contribution.effectiveModificationDepth);
    }

    return this.recalculate(activeMode, sessionSnapshot);
  }

  /**
   * Reverses the BRI contribution of a previously recorded paste (FR-06).
   * No-ops silently if the eventId is not in the contributions map.
   */
  public processUndo(
    eventId: string,
    activeMode: BoundedMode,
    sessionSnapshot: SessionSnapshot
  ): BRIState {
    this.contributions.delete(eventId);
    return this.recalculate(activeMode, sessionSnapshot);
  }

  /** Recomputes BRI when session counters change without a paste event. */
  public processSessionActivity(
    activeMode: BoundedMode,
    sessionSnapshot: SessionSnapshot
  ): BRIState {
    return this.recalculate(activeMode, sessionSnapshot);
  }

  public getCurrentBRI(): number {
    return this.currentBRI;
  }

  public reset(): void {
    this.contributions.clear();
    this.currentBRI = 0;
    this.startBRI = 0;
  }

  /** Derives the severity label from the current BRI value. */
  public getStateLabel(): BRIStateLabel {
    if (this.currentBRI <= 0.40) return 'low';
    if (this.currentBRI <= 0.74) return 'moderate';
    return 'severe';
  }

  /** BRI change since the session started. */
  public getBRIDelta(): number {
    return this.clampAndRound(this.currentBRI - this.startBRI);
  }

  /** Clamps value to [0.0, 1.0] and rounds to 2 decimal places. */
  private clampAndRound(value: number): number {
    return Math.round(this.clamp01(value) * 100) / 100;
  }

  private clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
  }

  private parseEventTime(occurredAt: string): number {
    const parsed = Date.parse(occurredAt);
    return Number.isNaN(parsed) ? Date.now() : parsed;
  }

  private estimateProjectLineCount(snapshot: SessionSnapshot, insertedLineCount: number): number {
    return Math.max(insertedLineCount, snapshot.linesTyped + snapshot.linesPasted);
  }

  private calculateEffectiveModificationDepth(
    rawModificationDepth: number,
    insertedLineCount: number,
    projectLineCount: number
  ): number {
    const projectBaseline = Math.max(insertedLineCount, projectLineCount * 0.25);
    const projectScale = Math.sqrt(insertedLineCount / projectBaseline);
    return this.clamp01(rawModificationDepth * projectScale);
  }

  /**
   * Session-level signals are intentionally small compared with paste
   * contributions; they refine the score without drowning the core behavior.
   */
  private calculateSessionAdjustment(snapshot: SessionSnapshot): number {
    const totalLines = snapshot.linesTyped + snapshot.linesPasted;
    const pasteRatio = totalLines > 0 ? snapshot.linesPasted / totalLines : 0;
    const typedRatio = totalLines > 0 ? snapshot.linesTyped / totalLines : 0;

    const pasteVolume = Math.min(snapshot.pasteEventCount * 0.015, 0.10);
    const pasteRatioLoad = Math.max(0, pasteRatio - 0.4) * 0.18;
    const typingCredit = Math.min(snapshot.longestTypingStreak * 0.002, 0.08);
    const typedRatioCredit = typedRatio * 0.04;

    return pasteVolume + pasteRatioLoad - typingCredit - typedRatioCredit;
  }

  /** Adds a burst signal when several active pastes happen in a short window. */
  private calculateFrequencyAdjustment(): number {
    const now = Date.now();
    const tenMinutesMs = 10 * 60 * 1000;
    const recentPasteCount = Array.from(this.contributions.values()).filter(
      (c) => now - c.occurredAtMs <= tenMinutesMs
    ).length;

    return Math.min(Math.max(0, recentPasteCount - 2) * 0.04, 0.12);
  }

  private recalculate(
    activeMode: BoundedMode,
    sessionSnapshot: SessionSnapshot
  ): BRIState {
    const pasteTotal = Array.from(this.contributions.values()).reduce(
      (sum, contribution) => sum + contribution.currentContribution,
      0
    );

    const rawBRI =
      pasteTotal +
      this.calculateSessionAdjustment(sessionSnapshot) +
      this.calculateFrequencyAdjustment();

    this.currentBRI = this.clampAndRound(
      sessionSnapshot.pasteEventCount > 0
        ? Math.max(MIN_BRI_WITH_ACTIVE_PASTE, rawBRI)
        : rawBRI
    );

    return {
      currentBRI: this.currentBRI,
      stateLabel: this.getStateLabel(),
      activeMode,
      lastSaved: new Date().toISOString(),
      sessionSnapshot: { ...sessionSnapshot },
    };
  }
}
