# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

NovelAI Scene Visualizer — an Electron desktop app that generates AI images alongside NovelAI stories using the NovelAI image generation API. Has two components:
1. **Electron App** (`app/`) — Desktop wrapper with embedded NovelAI webview + side panel for generated images
2. **Companion Script** (`script/scene-visualizer.ts`) — TypeScript userscript that runs inside NovelAI's Script API runtime, analyzes story text, and generates image prompts

## Commands

All commands run from `app/` directory:

```bash
cd app && npm install    # Install dependencies
npm run dev              # Run with dev tools open
npm start                # Run normally
npm run build            # Build for current platform
npm run build:mac        # Build macOS (DMG, ZIP)
npm run build:win        # Build Windows (NSIS, portable)
npm run build:linux      # Build Linux (AppImage, DEB)
npm run build:all        # Build all platforms
node test-api.js         # Manual API connectivity test
```

No linting, formatting, or automated test framework is configured.

## Architecture

### Electron App (app/)

**Main Process** (`main.js`): Creates BrowserWindow, manages IPC handlers, calls NovelAI image generation API (`https://image.novelai.net/ai/generate-image`). Handles 6 models (V3, V3 Furry, V4 Curated/Full, V4.5 Curated/Full) with model-specific parameter sets. API responses are ZIP files containing images, extracted via `adm-zip`.

**Renderer** (`renderer/index.html`): Single HTML file with inline JS/CSS. Contains embedded `<webview>` for NovelAI.net, a collapsible side panel for generated images, toolbar, and settings modal. Dark theme (`#1a1a2e` background, `#e94560` accent). No build step — vanilla HTML/JS/CSS.

**Preload Scripts**: Two context bridges:
- `preload.js` — Exposes `window.sceneVisualizer` API to renderer, watches for prompt changes via DOM mutation observer
- `webview-preload.js` — Exposes `window.__sceneVisualizerBridge` inside the NovelAI webview for script↔app communication. Also handles direct webview↔renderer IPC for suggestion insertion into ProseMirror.

### Communication Flow

```
Script (in NovelAI) → DOM data attributes → webview-preload.js (mutation observer)
    → preload.js → IPC → main.js → NovelAI API → image back through IPC → renderer
```

### Suggestion Insertion Flow (webview↔renderer IPC)

```
User clicks suggestion card → renderer calls webview.send('insert-suggestion', {text})
    → webview-preload.js receives via ipcRenderer.on()
    → Tries ProseMirror-compatible strategies (paste event → beforeinput → clipboard paste)
    → Sends result back via ipcRenderer.sendToHost('suggestion-inserted', result)
    → Renderer shows success/failure via webview 'ipc-message' event
```

**Why not `executeJavaScript()`?** ProseMirror ignores `document.execCommand('insertText')` because it maintains its own internal document state. Only events ProseMirror explicitly handles (paste, beforeinput) create proper transactions.

### Companion Script (script/scene-visualizer.ts)

TypeScript running in NovelAI's runtime. Analyzes story text (last 2000 chars), extracts character appearances from lorebook entries via regex, sends to GLM-4-6 model for prompt generation, then stores prompts in DOM bridge element for the app to read.

### Data Storage

`electron-store` with encryption stores API token and image generation settings (model, resolution, steps, scale, sampler, etc.).

## Key Configuration Objects

In `main.js`, these top-level constants define model behavior:
- `MODEL_CONFIG` — Model IDs and display names
- `QUALITY_PRESETS` — Per-model positive quality tags
- `UC_PRESETS` — Per-model negative prompt presets (heavy/light variants)

## Conventions

- Log messages prefixed with tags: `[SceneVis]`, `[Main]`, `[Preload]`, `[WebviewPreload]`
- File names: kebab-case; variables: camelCase; constants: UPPER_CASE
- Security: context isolation enabled, node integration disabled, IPC-only communication
