/**
 * sidebarPanel.ts
 * Implements the VS Code WebviewViewProvider for the Bounded sidebar panel.
 *
 * FR-10: No code content is ever included in any message or state object.
 */

import * as vscode from 'vscode';
import { BRIState, BoundedMode } from '../types';

export class SidebarPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'boundedSidebarView';
  private _view?: vscode.WebviewView;
  private _pendingState?: BRIState;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext<unknown>,
    _token: vscode.CancellationToken
  ): void {
    console.log('Bounded: resolveWebviewView called');
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };

    webviewView.webview.html = this._getHtmlContent(webviewView.webview);

    if (this._pendingState) {
      webviewView.webview.postMessage({ command: 'updateState', state: this._pendingState });
      this._pendingState = undefined;
    }

    webviewView.webview.onDidReceiveMessage(
      (message: { command: string; mode?: BoundedMode }) => {
        switch (message.command) {
          case 'toggleMode':
            vscode.commands.executeCommand('bounded.toggleMode');
            break;
          case 'openDashboard':
            vscode.commands.executeCommand('bounded.openDashboard');
            break;
        }
      },
      undefined,
      this.context.subscriptions
    );
  }

  public updateState(state: BRIState): void {
    if (this._view) {
      this._view.webview.postMessage({ command: 'updateState', state });
    } else {
      this._pendingState = state;
    }
  }

  private _getHtmlContent(webview: vscode.Webview): string {
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'sidebar.css')
    );
    const nonce = this._getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri.toString()}">
</head>
<body>
  <header class="panel-header">
    <div>
      <h1>Bounded</h1>
      <p id="coach-line">Writing independently</p>
    </div>
    <div class="header-actions">
      <button class="theme-toggle" id="theme-btn" title="Toggle theme">Light</button>
      <span class="mode-pill" id="mode-pill">Standard</span>
    </div>
  </header>

  <section class="bri-panel">
    <div class="bri-gauge-container">
      <svg class="bri-ring" width="124" height="124" viewBox="0 0 124 124">
        <circle cx="62" cy="62" r="52"
          fill="none" stroke="var(--vscode-badge-background)"
          stroke-width="8"/>
        <circle id="bri-arc" cx="62" cy="62" r="52"
          fill="none" stroke="var(--vscode-terminal-ansiGreen)"
          stroke-width="8"
          stroke-linecap="round"
          stroke-dasharray="327"
          stroke-dashoffset="327"
          transform="rotate(-90 62 62)"/>
      </svg>
      <div class="bri-center">
        <div class="bri-caption">BRI</div>
        <div class="bri-value" id="bri-value">0</div>
      </div>
    </div>
    <div class="bri-label label-low" id="bri-label">LOW</div>
  </section>

  <section class="session-section">
    <h2>Session</h2>
    <table class="snapshot-table">
      <tr><td>Lines Typed</td>        <td id="lines-typed">0</td></tr>
      <tr><td>Lines Inserted</td>     <td id="lines-pasted">0</td></tr>
      <tr><td>Insert Events</td>      <td id="paste-count">0</td></tr>
      <tr><td>Unmodified Inserts</td> <td id="unmodified">0</td></tr>
      <tr><td>Writing Streak</td>     <td id="streak">0</td></tr>
    </table>
  </section>

  <div class="actions">
    <button class="mode-toggle" id="mode-btn">Mode: Standard</button>
    <button class="dashboard-btn" id="dashboard-btn">Open Dashboard</button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    const arc = document.getElementById('bri-arc');
    const briValue = document.getElementById('bri-value');
    const briLabel = document.getElementById('bri-label');
    const modePill = document.getElementById('mode-pill');
    const coachLine = document.getElementById('coach-line');
    const themeBtn = document.getElementById('theme-btn');
    const modeBtn = document.getElementById('mode-btn');
    const dashBtn = document.getElementById('dashboard-btn');
    const savedState = vscode.getState() || {};

    function applyTheme(theme) {
      document.body.dataset.theme = theme;
      themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light';
      vscode.setState({ ...savedState, theme });
    }

    applyTheme(savedState.theme || 'dark');

    const CIRCUMFERENCE = 327;

    const labelClasses = {
      low: 'bri-label label-low',
      moderate: 'bri-label label-moderate',
      severe: 'bri-label label-severe'
    };

    const arcColors = {
      low: 'var(--vscode-terminal-ansiGreen)',
      moderate: 'var(--vscode-terminal-ansiYellow, #facc15)',
      severe: 'var(--vscode-errorForeground)'
    };

    const coachCopy = {
      low: 'Writing independently',
      moderate: 'Pause and review inserted code',
      severe: 'Try the next block yourself'
    };

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.command !== 'updateState') { return; }

      const { currentBRI, stateLabel, activeMode, sessionSnapshot } = msg.state;

      arc.style.strokeDashoffset = CIRCUMFERENCE - (currentBRI * CIRCUMFERENCE);
      arc.style.stroke = arcColors[stateLabel] || arcColors.low;

      briValue.textContent = Math.round(currentBRI * 100);
      briLabel.className = labelClasses[stateLabel] || labelClasses.low;
      briLabel.textContent = stateLabel.toUpperCase();

      document.getElementById('lines-typed').textContent = sessionSnapshot.linesTyped;
      document.getElementById('lines-pasted').textContent = sessionSnapshot.linesPasted;
      document.getElementById('paste-count').textContent = sessionSnapshot.pasteEventCount;
      document.getElementById('unmodified').textContent = sessionSnapshot.unmodifiedPastes;
      document.getElementById('streak').textContent = sessionSnapshot.longestTypingStreak;

      modeBtn.textContent = 'Mode: ' + activeMode;
      modePill.textContent = activeMode;
      coachLine.textContent = coachCopy[stateLabel] || coachCopy.low;
    });

    modeBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'toggleMode' });
    });

    dashBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'openDashboard' });
    });

    themeBtn.addEventListener('click', () => {
      applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light');
    });
  </script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
  }
}
