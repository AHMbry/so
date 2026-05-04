/**
 * alertController.ts
 * Monitors BRI state after every update and fires the alert callback when
 * the mode-specific threshold is crossed.
 *
 * Deduplication: an alert fires at most once per severity band. Once the BRI
 * returns to 'low', the latch resets so the next escalation fires again.
 *
 * NF-06: Alert language must be neutral — this module only passes the
 *        BRIStateLabel to the callback; wording is the caller's responsibility.
 */

import { BRIStateLabel } from '../types';
import { ModeManager } from './modeManager';

export class AlertController {
  /** The last label we alerted on; null means no active alert. */
  private lastAlertedLabel: BRIStateLabel | null = null;

  constructor(
    private readonly modeManager: ModeManager,
    private readonly onAlert: (label: BRIStateLabel) => void
  ) {}

  /**
   * Called after every BRI update.
   * Fires onAlert when:
   *   - The mode says we should alert for this label, AND
   *   - We have not already alerted for this label (deduplication).
   * Resets the latch when BRI returns to 'low'.
   *
   * isInsertEvent: when true and mode is Strict and threshold is already reached,
   * skips deduplication so every subsequent insert fires a nudge.
   */
  public check(stateLabel: BRIStateLabel, isInsertEvent: boolean = false): void {
    if (stateLabel === 'low') {
      this.lastAlertedLabel = null;
      return;
    }

    if (!this.modeManager.shouldAlert(stateLabel)) {
      return;
    }

    const alreadyAtThreshold =
      this.lastAlertedLabel !== null && stateLabel === this.lastAlertedLabel;
    const strictRepeat =
      isInsertEvent && this.modeManager.getMode() === 'Strict' && alreadyAtThreshold;

    if (!alreadyAtThreshold || strictRepeat) {
      this.lastAlertedLabel = stateLabel;
      this.onAlert(stateLabel);
    }
  }

  /** Manually resets the alert latch (e.g., after session reset). */
  public reset(): void {
    this.lastAlertedLabel = null;
  }
}
