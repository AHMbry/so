/**
 * onboardingFlow.ts
 * Multi-screen first-launch WebView for the Bounded extension.
 *
 * Shows four screens: Welcome → BRI Explainer → Mode Selection → Privacy.
 * Persists completion state in VS Code's globalState so it never re-shows.
 * globalState key: 'bounded.onboardingComplete' (boolean)
 *
 * Architecture rules observed:
 *   - postMessage / onDidReceiveMessage only for WebView ↔ Host communication
 *   - No code content stored or logged (FR-10)
 *   - Alert language is neutral — no punishment words (NF-06)
 *   - No network calls (NF-09)
 */

import * as vscode from 'vscode';
import { BoundedMode } from '../types';

export class OnboardingFlow {
  private static readonly viewType = 'boundedOnboarding';
  private panel: vscode.WebviewPanel | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  /** Returns true if the user has already completed onboarding. */
  public isComplete():  boolean {
  return false; // temporary — remove after testing
}
  // boolean {
  //   return this.context.globalState.get<boolean>(
  //     'bounded.onboardingComplete', false
  //   );
  // }

  /** Opens the onboarding panel if not yet complete. Safe to call every launch. */
  public show(): void {
    if (this.isComplete()) { return; }

    this.panel = vscode.window.createWebviewPanel(
      OnboardingFlow.viewType,
      'Welcome to Bounded',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, 'media')
        ]
      }
    );

    const cssUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'onboarding.css')
    );
    const nonce = this._getNonce();
    this.panel.webview.html = this._getHtml(cssUri, nonce);

    // Handle messages from the onboarding WebView
    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; mode?: BoundedMode }) => {
        if (message.command === 'complete') {
          // Persist the user's mode choice to VS Code settings
          if (message.mode) {
            await vscode.workspace.getConfiguration().update(
              'bounded.mode',
              message.mode,
              vscode.ConfigurationTarget.Global
            );
          }
          // Mark onboarding complete — never shown again
          await this.context.globalState.update(
            'bounded.onboardingComplete', true
          );
          this.panel?.dispose();
        }
        if (message.command === 'skip') {
          await this.context.globalState.update(
            'bounded.onboardingComplete', true
          );
          this.panel?.dispose();
        }
      }
    );
  }

  private _getHtml(cssUri: vscode.Uri, nonce: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src ${this.panel!.webview.cspSource};
             script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>

  <!-- Screen 1: Welcome -->
  <div class="screen active" id="screen-1">
    <div class="logo">Bounded</div>
    <div class="tagline">Stay in control of your own thinking.</div>
    <div class="card">
      <h2>Welcome</h2>
      <p>
        Bounded monitors your coding sessions to help you recognize
        when you have stopped engaging with the code you are using.
        It works quietly in the background and never reads or stores
        what you write — only how you write it.
      </p>
    </div>
    <div class="nav">
      <button class="btn-primary" id="btn-get-started">Get Started</button>
      <button class="btn-ghost"    id="btn-skip">Skip</button>
    </div>
    <div class="dots-nav">
      <div class="dot-nav active"></div>
      <div class="dot-nav"></div>
      <div class="dot-nav"></div>
      <div class="dot-nav"></div>
    </div>
  </div>

  <!-- Screen 2: How BRI Works -->
  <div class="screen" id="screen-2">
    <div class="card">
      <h2>The Behavioral Reliance Index</h2>
      <p>
        Every session, Bounded computes a BRI score from 0.0 to 1.0
        based on how much external code you accept without engaging
        with it. The score has three states:
      </p>
      <div class="bri-explainer">
        <div class="level">
          <div class="dot low"></div>
          <span><strong>Low (0.0 – 0.40)</strong> — You are writing independently.</span>
        </div>
        <div class="level">
          <div class="dot moderate"></div>
          <span><strong>Moderate (0.41 – 0.74)</strong> — Some reliance detected.</span>
        </div>
        <div class="level">
          <div class="dot severe"></div>
          <span><strong>Severe (0.75 – 1.0)</strong> — Consider slowing down.</span>
        </div>
      </div>
    </div>
    <div class="nav">
      <button class="btn-ghost"    id="btn-back-2">Back</button>
      <button class="btn-primary"  id="btn-next-2">Next</button>
    </div>
    <div class="dots-nav">
      <div class="dot-nav"></div>
      <div class="dot-nav active"></div>
      <div class="dot-nav"></div>
      <div class="dot-nav"></div>
    </div>
  </div>

  <!-- Screen 3: Choose Mode -->
  <div class="screen" id="screen-3">
    <div class="card">
      <h2>Choose Your Mode</h2>
      <p>You can change this any time from the sidebar.</p>
      <div class="mode-cards">
        <div class="mode-card selected" id="card-standard">
          <h3>Standard</h3>
          <p>Silent until BRI reaches severe. One alert per climb.</p>
        </div>
        <div class="mode-card" id="card-strict">
          <h3>Strict</h3>
          <p>Nudges at moderate. Escalates at severe.</p>
        </div>
      </div>
    </div>
    <div class="nav">
      <button class="btn-ghost"   id="btn-back-3">Back</button>
      <button class="btn-primary" id="btn-next-3">Next</button>
    </div>
    <div class="dots-nav">
      <div class="dot-nav"></div>
      <div class="dot-nav"></div>
      <div class="dot-nav active"></div>
      <div class="dot-nav"></div>
    </div>
  </div>

  <!-- Screen 4: Privacy + Get Started -->
  <div class="screen" id="screen-4">
    <div class="card">
      <h2>Your Privacy</h2>
      <ul class="privacy-list">
        <li>No code content is ever read or stored</li>
        <li>No data leaves your machine</li>
        <li>No internet connection required</li>
        <li>Only behavioral metadata is tracked</li>
        <li>You can uninstall at any time</li>
      </ul>
    </div>
    <div class="nav">
      <button class="btn-ghost"   id="btn-back-4">Back</button>
      <button class="btn-primary" id="btn-complete">Start Using Bounded</button>
    </div>
    <div class="dots-nav">
      <div class="dot-nav"></div>
      <div class="dot-nav"></div>
      <div class="dot-nav"></div>
      <div class="dot-nav active"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let selectedMode = 'Standard';
    let currentScreen = 1;

    function goTo(n) {
      document.getElementById('screen-' + currentScreen).classList.remove('active');
      const newScreen = document.getElementById('screen-' + n);
      newScreen.classList.add('active');
      currentScreen = n;

      // Update dot indicators for the newly active screen
      const dots = newScreen.querySelectorAll('.dot-nav');
      dots.forEach(function(dot, i) {
        dot.classList.toggle('active', i + 1 === n);
      });
    }

    function selectMode(mode) {
      selectedMode = mode;
      document.getElementById('card-standard').classList.toggle('selected', mode === 'Standard');
      document.getElementById('card-strict').classList.toggle('selected', mode === 'Strict');
    }

    // ── Wire navigation buttons via addEventListener (inline onclick is
    //    blocked by the CSP nonce policy) ──────────────────────────────────
    document.getElementById('btn-get-started').addEventListener('click', function() { goTo(2); });
    document.getElementById('btn-skip').addEventListener('click', function() {
      vscode.postMessage({ command: 'skip' });
    });

    document.getElementById('btn-back-2').addEventListener('click', function() { goTo(1); });
    document.getElementById('btn-next-2').addEventListener('click', function() { goTo(3); });

    document.getElementById('card-standard').addEventListener('click', function() { selectMode('Standard'); });
    document.getElementById('card-strict').addEventListener('click', function() { selectMode('Strict'); });

    document.getElementById('btn-back-3').addEventListener('click', function() { goTo(2); });
    document.getElementById('btn-next-3').addEventListener('click', function() { goTo(4); });

    document.getElementById('btn-back-4').addEventListener('click', function() { goTo(3); });
    document.getElementById('btn-complete').addEventListener('click', function() {
      vscode.postMessage({ command: 'complete', mode: selectedMode });
    });
  </script>

</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const possible =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(
        Math.floor(Math.random() * possible.length)
      );
    }
    return text;
  }
}
