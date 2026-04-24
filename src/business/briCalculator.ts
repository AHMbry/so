/**
 * briCalculator.ts
 * Core BRI computation module. Maintains the current BRI score in memory,
 * applies increase/decrease rules per event, and derives the state label.
 *
 * Rules (from BOUNDED_REFERENCE §8):
 *   - External paste, lineCount ≥ 3, modificationDepth === 0
 *       → increase by min(0.05 + lineCount * 0.005, 0.15)
 *   - Paste undone → decrease by the exact contribution stored for that eventId
 *   - Internal paste → no change (FR-04)
 *   - BRI is always clamped to [0.0, 1.0] and rounded to 2 decimal places
 *
 * FR-10: No code content is ever stored here — only numeric scores and IDs.
 */

import { BehavioralEvent, BRIState, BRIStateLabel, DEFAULT_BRI_STATE } from '../types';

export class BRICalculator {
  private currentBRI: number;
  private startBRI: number;
  /** Maps eventId → contribution amount so undos reverse the exact delta. */
  private contributions: Map<string, number> = new Map();

  constructor(initialBRI: number) {
    this.currentBRI = this.clampAndRound(initialBRI);
    this.startBRI = this.currentBRI;
  }

  /**
   * Applies BRI increase rules for an external paste event.
   * Internal pastes are silently ignored (FR-04).
   * Returns a partial BRIState — caller must merge activeMode and sessionSnapshot.
   */
  public processPaste(event: BehavioralEvent): BRIState {
    if (!event.isInternal && event.lineCount >= 3 && event.modificationDepth === 0) {
      const contribution = Math.min(0.05 + event.lineCount * 0.005, 0.15);
      this.currentBRI = this.clampAndRound(this.currentBRI + contribution);
      this.contributions.set(event.eventId, contribution);
    }
    return this.buildPartialState();
  }

  /**
   * Reverses the BRI contribution of a previously recorded paste (FR-06).
   * No-ops silently if the eventId is not in the contributions map.
   * Returns a partial BRIState — caller must merge activeMode and sessionSnapshot.
   */
  public processUndo(eventId: string): BRIState {
    const contribution = this.contributions.get(eventId);
    if (contribution !== undefined) {
      this.currentBRI = this.clampAndRound(this.currentBRI - contribution);
      this.contributions.delete(eventId);
    }
    return this.buildPartialState();
  }

  public getCurrentBRI(): number {
    return this.currentBRI;
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
    return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
  }

  /**
   * Builds a BRIState with the fields this module owns.
   * activeMode and sessionSnapshot are placeholders — the caller (extension.ts)
   * assembles the full state when persisting to disk.
   */
  private buildPartialState(): BRIState {
    return {
      currentBRI: this.currentBRI,
      stateLabel: this.getStateLabel(),
      activeMode: 'Standard',            // placeholder — use modeManager.getMode()
      lastSaved: new Date().toISOString(),
      sessionSnapshot: { ...DEFAULT_BRI_STATE.sessionSnapshot }, // placeholder
    };
  }
}
