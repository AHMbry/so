import { BoundedMode, BRIStateLabel, SessionSnapshot } from '../types';

type AlertReason = 'no-typing' | 'high-insert-ratio' | 'many-inserts' | 'default';

const STANDARD_MESSAGES: Record<BRIStateLabel, Record<AlertReason, string[]>> = {
  low: {
    'no-typing': [],
    'high-insert-ratio': [],
    'many-inserts': [],
    default: [],
  },
  moderate: {
    'no-typing': [],
    'high-insert-ratio': [],
    'many-inserts': [],
    default: [],
  },
  severe: {
    'no-typing': [
      'Bounded: BRI is high and this session has not recorded typed lines yet. Try writing the next small block yourself.',
      'Bounded: Your reliance index is high with little manual input so far. Add a small hand-written change before continuing.',
    ],
    'high-insert-ratio': [
      'Bounded: BRI is high because inserted code is carrying most of this session. Pause and write the next block manually.',
      'Bounded: Inserted code is dominating the session right now. Try rebuilding one section in your own words.',
    ],
    'many-inserts': [
      'Bounded: Several inserted-code events have pushed BRI high. Review one insert, then continue with a manual change.',
      'Bounded: BRI is high after multiple insert events. Slow down for a moment and write the next step yourself.',
    ],
    default: [
      'Bounded: Your reliance index is high. Consider writing the next block yourself.',
      'Bounded: BRI is high right now. A short manual pass can help rebalance the session.',
    ],
  },
};

const STRICT_MESSAGES: Record<BRIStateLabel, Record<AlertReason, string[]>> = {
  low: {
    'no-typing': [],
    'high-insert-ratio': [],
    'many-inserts': [],
    default: [],
  },
  moderate: {
    'no-typing': [
      'Bounded Strict: Early nudge - typed lines are still low. Write the next small step manually.',
      'Bounded Strict: You are entering reliance territory with little typed code. Add one manual line before moving on.',
    ],
    'high-insert-ratio': [
      'Bounded Strict: Inserted code is starting to outweigh typed work. Pause and write the next block yourself.',
      'Bounded Strict: Inserted lines are taking the lead. Try explaining and editing one section before continuing.',
    ],
    'many-inserts': [
      'Bounded Strict: Several insert events appeared quickly. Take a moment to write the next change manually.',
      'Bounded Strict: Insert frequency is rising. Slow the loop and add a hand-written step.',
    ],
    default: [
      'Bounded Strict: BRI is moderate. This is a good moment to rebalance with manual writing.',
      'Bounded Strict: Early reliance signal detected. Try the next small change without inserting code.',
    ],
  },
  severe: {
    'no-typing': [
      'Bounded Strict: BRI is severe and typed work is still very low. Stop and rebuild a small section manually.',
      'Bounded Strict: Strong reliance signal with little manual input. Write the next block yourself before continuing.',
    ],
    'high-insert-ratio': [
      'Bounded Strict: Severe reliance signal - inserted code is carrying most of the session. Rework one section manually.',
      'Bounded Strict: Inserted lines are dominating. Pause, review, and rewrite a small piece yourself.',
    ],
    'many-inserts': [
      'Bounded Strict: Severe reliance signal after multiple insert events. Slow down and write the next step manually.',
      'Bounded Strict: Insert events have stacked up. Rebalance by writing a small block from scratch.',
    ],
    default: [
      'Bounded Strict: BRI is severe. Take a short manual pass before accepting more inserted code.',
      'Bounded Strict: Strong reliance signal detected. Try rebuilding the next function from memory.',
    ],
  },
};

export function buildAlertMessage(
  label: BRIStateLabel,
  mode: BoundedMode,
  snapshot: SessionSnapshot
): string {
  const reason = getAlertReason(snapshot);
  const copy = mode === 'Strict' ? STRICT_MESSAGES : STANDARD_MESSAGES;
  const variants = copy[label][reason].length > 0 ? copy[label][reason] : copy[label].default;

  if (variants.length === 0) {
    return `Bounded: Your reliance index is ${label}. Consider writing the next block yourself.`;
  }

  return variants[selectVariantIndex(variants.length, label, mode, snapshot)];
}

function getAlertReason(snapshot: SessionSnapshot): AlertReason {
  const totalLines = snapshot.linesTyped + snapshot.linesPasted;
  const insertedRatio = totalLines > 0 ? snapshot.linesPasted / totalLines : 0;

  if (snapshot.linesTyped === 0 && snapshot.linesPasted > 0) {
    return 'no-typing';
  }

  if (insertedRatio >= 0.7) {
    return 'high-insert-ratio';
  }

  if (snapshot.pasteEventCount >= 4) {
    return 'many-inserts';
  }

  return 'default';
}

function selectVariantIndex(
  variantCount: number,
  label: BRIStateLabel,
  mode: BoundedMode,
  snapshot: SessionSnapshot
): number {
  const seed =
    snapshot.linesTyped * 31 +
    snapshot.linesPasted * 17 +
    snapshot.pasteEventCount * 13 +
    snapshot.longestTypingStreak * 7 +
    label.length +
    mode.length;

  return Math.abs(seed) % variantCount;
}
