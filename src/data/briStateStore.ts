/**
 * briStateStore.ts
 * Data-layer module responsible for reading and writing the BRI state to
 * bri-state.json inside VS Code's globalStorage directory.
 *
 * Guarantees:
 *   - Never stores or transmits code content (FR-10).
 *   - Returns DEFAULT_BRI_STATE on first launch or file corruption (NF-11).
 *   - Creates the storage directory automatically if it does not exist.
 *   - All I/O is async.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { BRIState, DEFAULT_BRI_STATE } from '../types';

const FILE_NAME = 'bri-state.json';

// ── Path helper ───────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to bri-state.json inside VS Code's
 * per-extension globalStorage folder.
 */
function getBRIStatePath(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, FILE_NAME);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Reads BRIState from disk.
 * Returns DEFAULT_BRI_STATE if the file is missing or cannot be parsed.
 */
export async function readBRIState(context: vscode.ExtensionContext): Promise<BRIState> {
  const filePath = getBRIStatePath(context);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as BRIState;
  } catch (err: unknown) {
    const isNotFound =
      typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT';
    if (!isNotFound) {
      // File exists but is corrupt — warn and recover
      console.warn('Bounded: bri-state.json is corrupt — recovering to default state.', err);
    }
    return { ...DEFAULT_BRI_STATE, lastSaved: new Date().toISOString() };
  }
}

/**
 * Writes the given BRIState to disk, stamping lastSaved with the current time.
 * Creates the globalStorage directory if it does not exist (first launch).
 */
export async function writeBRIState(
  context: vscode.ExtensionContext,
  state: BRIState
): Promise<void> {
  const dir = context.globalStorageUri.fsPath;
  await fs.mkdir(dir, { recursive: true });

  const updated: BRIState = { ...state, lastSaved: new Date().toISOString() };
  await fs.writeFile(getBRIStatePath(context), JSON.stringify(updated, null, 2), 'utf-8');

  // TODO: Phase 4 — notify BRI Calculator that state has been persisted
  // TODO: Phase 6 — trigger Sidebar Panel refresh after write
}
