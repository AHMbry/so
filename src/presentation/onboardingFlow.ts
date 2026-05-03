/**
 * onboardingFlow.ts
 * Multi-screen first-launch WebView for the Bounded extension.
 */

import * as vscode from 'vscode';
import { BoundedMode } from '../types';

export class OnboardingFlow {
  private static readonly viewType = 'boundedOnboarding';
  private panel: vscode.WebviewPanel | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  public isComplete(): boolean {
    return false;
  }

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

    this.panel.webview.onDidReceiveMessage(
      async (message: { command: string; mode?: BoundedMode }) => {
        if (message.command === 'complete') {
          if (message.mode) {
            await vscode.workspace.getConfiguration().update(
              'bounded.mode',
              message.mode,
              vscode.ConfigurationTarget.Global
            );
          }
          await this.context.globalState.update('bounded.onboardingComplete', true);
          this.panel?.dispose();
        }
        if (message.command === 'skip') {
          await this.context.globalState.update('bounded.onboardingComplete', true);
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
  <main class="shell">
    <header class="topbar">
      <div>
        <div class="brand">Bounded</div>
        <p>Build awareness around inserted code while you learn!</p>
      </div>
      <button class="theme-toggle" id="theme-btn">Light</button>
    </header>

    <nav class="progress" aria-label="Onboarding progress">
      <span class="step active" data-step="1">Welcome</span>
      <span class="step" data-step="2">BRI</span>
      <span class="step" data-step="3">Mode selection</span>
      <span class="step" data-step="4">Privacy</span>
    </nav>

    <section class="screen active" id="screen-1">
      <div class="intro-grid">
        <div class="hero-copy">
          <span class="eyebrow">Coding coach for VS Code</span>
          <h1>Stay in control of your own thinking!</h1>
          <p>
            Bounded watches coding behavior, not code content, and helps you notice
            when inserted code starts to replace active understanding.
          </p>
        </div>
        <div class="preview-panel">
          <div class="preview-header">
            <span>BRI</span><strong>24</strong>
          </div>
          <div class="preview-meter"><span></span></div>
          <dl>
            <div><dt>Lines Typed</dt><dd>86</dd></div>
            <div><dt>Lines Inserted</dt><dd>18</dd></div>
            <div><dt>Writing Streak</dt><dd>22</dd></div>
          </dl>
        </div>
      </div>
    </section>

    <section class="screen" id="screen-2">
      <div class="content-panel">
        <span class="eyebrow">Behavioral Reliance Index</span>
        <h1>BRI shows how much (or how little) you are engaging with your code.</h1>
        <p>
          The score rises when large inserted blocks are accepted without meaningful
          changes, and falls as you write more code yourself.
        </p>
        <div class="bri-levels">
          <div><span class="dot low"></span><strong>Low</strong><em>0-40</em></div>
          <div><span class="dot moderate"></span><strong>Moderate</strong><em>41-74</em></div>
          <div><span class="dot severe"></span><strong>Severe</strong><em>75-100</em></div>
        </div>
      </div>
    </section>

    <section class="screen" id="screen-3">
      <div class="content-panel">
        <span class="eyebrow">Choose an alert level</span>
        <h1>Pick how early Bounded should notify you about your coding behavior.</h1>
        <div class="mode-cards">
          <button class="mode-card selected" id="card-standard">
            <strong>Standard</strong>
            <span>Silent until severe dependency is detected.</span>
          </button>
          <button class="mode-card" id="card-strict">
            <strong>Strict</strong>
            <span>More frequent alerts, begins at moderate dependency.</span>
          </button>
        </div>
      </div>
    </section>

    <section class="screen" id="screen-4">
      <div class="content-panel">
        <span class="eyebrow">Local by design</span>
        <h1>Your code stays yours.</h1>
        <ul class="privacy-list">
          <li>No code content is stored</li>
          <li>No data leaves your machine</li>
          <li>Only counts and scores are tracked</li>
          <li>You can change mode any time</li>
        </ul>
      </div>
    </section>

    <footer class="nav">
      <button class="btn-secondary" id="btn-back">Back</button>
      <button class="btn-secondary" id="btn-skip">Skip</button>
      <button class="btn-primary" id="btn-next">Get Started</button>
    </footer>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const savedState = vscode.getState() || {};
    let selectedMode = 'Standard';
    let currentScreen = 1;

    const backBtn = document.getElementById('btn-back');
    const nextBtn = document.getElementById('btn-next');
    const skipBtn = document.getElementById('btn-skip');
    const themeBtn = document.getElementById('theme-btn');

    function applyTheme(theme) {
      document.body.dataset.theme = theme;
      themeBtn.textContent = theme === 'light' ? 'Dark' : 'Light';
      themeBtn.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      vscode.setState({ ...savedState, theme });
    }

    function goTo(n) {
      document.getElementById('screen-' + currentScreen).classList.remove('active');
      document.getElementById('screen-' + n).classList.add('active');
      document.querySelectorAll('.step').forEach(step => {
        step.classList.toggle('active', Number(step.dataset.step) === n);
      });
      currentScreen = n;
      backBtn.disabled = currentScreen === 1;
      nextBtn.textContent = currentScreen === 4 ? 'Start Using Bounded' : 'Next';
    }

    function selectMode(mode) {
      selectedMode = mode;
      document.getElementById('card-standard').classList.toggle('selected', mode === 'Standard');
      document.getElementById('card-strict').classList.toggle('selected', mode === 'Strict');
    }

    applyTheme(savedState.theme || 'dark');
    goTo(1);

    backBtn.addEventListener('click', () => goTo(Math.max(1, currentScreen - 1)));
    nextBtn.addEventListener('click', () => {
      if (currentScreen === 4) {
        vscode.postMessage({ command: 'complete', mode: selectedMode });
      } else {
        goTo(currentScreen + 1);
      }
    });
    skipBtn.addEventListener('click', () => vscode.postMessage({ command: 'skip' }));
    themeBtn.addEventListener('click', () => {
      applyTheme(document.body.dataset.theme === 'light' ? 'dark' : 'light');
    });
    document.getElementById('card-standard').addEventListener('click', () => selectMode('Standard'));
    document.getElementById('card-strict').addEventListener('click', () => selectMode('Strict'));
  </script>
</body>
</html>`;
  }

  private _getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
