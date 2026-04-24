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
   */
  public check(stateLabel: BRIStateLabel): void {
    if (stateLabel === 'low') {
      this.lastAlertedLabel = null; // reset — allow future alerts on next escalation
      return;
    }

    if (
      this.modeManager.shouldAlert(stateLabel) &&
      stateLabel !== this.lastAlertedLabel
    ) {
      this.lastAlertedLabel = stateLabel;
      this.onAlert(stateLabel);
    }
  }

  /** Manually resets the alert latch (e.g., after session reset). */
  public reset(): void {
    this.lastAlertedLabel = null;
  }
}
