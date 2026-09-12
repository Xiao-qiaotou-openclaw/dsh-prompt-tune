# dsh-prompt-tune

[![CI](https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-prompt-tune)](https://www.npmjs.com/package/dsh-prompt-tune)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
![GitHub topic: dsh-plugin](https://img.shields.io/badge/github-dsh--plugin-blue)

**A one-click "optimize prompt" button for the DeepSeek Harness composer.** Write a rough draft, hit the ✨ control, and the draft is rewritten into a clearer, more specific, more actionable prompt by the model DSH is already configured with — then written straight back into the composer. The same control becomes an undo button that restores exactly what you typed.

English | [简体中文](./README.zh.md)

## What it does

One icon-only control in the composer tool row, with three states:

| State | Icon | When |
| --- | --- | --- |
| Optimize | ✨ sparkle | The draft is non-empty and the composer is idle (`phase === 'plain'`) |
| Optimizing | spinning loader (disabled) | A request is in flight |
| Undo | ↺ refresh | The last optimization was written back |

Clicking **Undo** restores the draft captured when the optimization started.

## Behavior worth knowing

- **Your newer edits always win.** The result is written back only if the draft still equals the snapshot the request started from. If you kept typing, the result is discarded silently rather than overwriting you.
- **Failures never touch your draft.** A missing model, a provider error, an empty answer, or a timeout leaves the composer exactly as it was; the reason appears on the control's `title` (and briefly as a warning colour) instead of only reaching the console.
- **It cannot spin forever.** The browser stops waiting after 45 seconds and aborts the request; the host aborts the model call at 60 seconds.
- **Sending or clearing the draft retires the undo target** — the control returns to its idle shape, so a stale original can never be pasted over a fresh draft.
- **Bounds:** drafts up to 20 000 characters, output capped at 2048 tokens, reasoning off, temperature 0.3.

## How it works

```
click → client reads the live draft through the standard `useInput` hook
      → POST /dsh-prompt-tune/api/optimize { prompt }
      → host: agentDefaultModel.currentSelection() → ctx.llm.stream(...) → aggregate text deltas
      → { optimized }
      → client: draft unchanged ? inputActions.setDraft(optimized) : discard
```

| File | Role |
| --- | --- |
| `lib/index.js` | Host half (ESM): registers one prefix route on the shared `webServer`, calls `ctx.llm.stream` with reasoning off, temperature 0.3 and a 2048-token cap. |
| `client/client.js` | Browser half: hand-written CJS inside the harness module-loader envelope, registering one control into the `conversation.input.left` slot. |
| `cordis.patch.yml` | Mounts the package as a profile layer. |
| `scripts/check-manifest.mjs` | The release gate: package name vs. registered module id, `exports`/patch targets, `engines.dsh`, and the zero-dependency / no-install-script rules. |
| `test/` | `node:test` suites — host route (12 cases) and browser half (13 cases). |

### No build step, no dependencies, no install scripts

The browser half is hand-written `React.createElement` CJS wrapped in the
`window.__ModuleLoader__.load({ id, factory })` envelope the harness web shell expects; the host half is plain ESM. Both halves are committed as written, so a GitHub install needs no build, `dependencies` stays empty, every peer is optional, nothing is downloaded at install time, and there is no `postinstall`/`prepare` script for pnpm ≥ 10 to block.

The browser half requires only **platform seed modules** (`react` and `@deepseek-ai/dsh-client-ui-primitives`, both provided by the harness module table); the host half imports `@deepseek-ai/dsh-llm` from the host.

## Requirements

| | |
| --- | --- |
| DSH | `>= 0.1.2-rc.1` (declared as `engines.dsh`; verified on `0.1.2-rc.1`) |
| Web client | Chromium-based browser — the control lives in the web composer; TUI / ACP / headless do not load the browser half |
| Node | `^22.19.0 \|\| >=24.0.0` (development only: nothing is built or run at install time) |
| Model | Any route DSH can serve. The default model comes from the `agent-default-model` settings section, so the official DeepSeek route or any configured provider works |

## Install

Once published to npm:

```sh
dsh plugin --profile web add dsh-prompt-tune
# then restart dsh web
```

From a GitHub repository:

```sh
dsh plugin --profile web add github:Xiao-qiaotou-openclaw/dsh-prompt-tune
# then restart dsh web
```

Installing straight into a profile without pnpm is also supported (it is how this
plugin was developed — see [CONTRIBUTING.md](./CONTRIBUTING.md)): copy the
repository into `<profile>/node_modules/dsh-prompt-tune` and add one insert row
to the profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-prompt-tune
      name: 'dsh-prompt-tune'
```

> Adding or removing an insert row in `cordis.patch.yml` is applied **live** by the
> profile's config watcher — no restart is needed, as long as the package resolves
> from `<profile>/node_modules`. Client-half edits also arrive without a restart:
> `dsh-client-hmr` polls every client bundle and pushes changes to the browser.
> If a new row does not appear within a few seconds, restart `dsh web`: a row whose
> package could not be imported at that moment stays failed until something
> re-triggers it.

## Usage

1. Type (or keep) a draft in the composer.
2. Click the ✨ control; it spins while the model works.
3. The draft is replaced by the optimized prompt and the control becomes ↺.
4. Review it, edit it, send it — or click ↺ to restore your original draft.

A greyed-out control means the draft is empty or the composer is mid-send. If a
request fails, hover the control to read the reason.

## Privacy and data flow

Your draft goes to the model provider DSH is configured with, over the same
channel a normal session request uses: browser → your own `dsh` host → the
harness LLM service → the configured provider. The plugin adds no third-party
endpoint, writes nothing to disk, collects nothing, and sends the draft nowhere
else. Treat it like sending the message itself: what you would not send to that
provider is what you should not optimize.

## Development

```sh
npm install          # development only: @deepseek-ai/dsh-llm, needed by the host test
npm run verify       # manifest check + both suites
npm test             # the two suites
npm run check        # the release gate alone
```

The two hard rules (no build step, no dependencies), the composer slot contract,
how to install a local checkout into a profile, and which half needs a restart are
all in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Uninstall

```sh
dsh plugin --profile web remove dsh-prompt-tune
# also delete any hand-added insert row from the profile's cordis.patch.yml
# then restart dsh web
```

## Why another prompt-optimizer plugin?

The DSH ecosystem already has several — pick the one that fits:

| Plugin | Shape |
| --- | --- |
| [`dsh-prompt-enhance`](https://github.com/rongxingda/dsh-prompt-enhance) | The closest sibling: composer button plus a before/after preview panel, one-click undo, shortcut, `/enhance` command, live settings page. Apache-2.0. |
| [`dsh-prompt-polish`](https://github.com/1321928757/dsh-prompt-polish) | Six rewriting strategies × three languages, optional session context, confirm dialog, history. |
| [`dsh-prompt-refine`](https://github.com/sojo-negai/dsh-prompt-refine) | Suggests three "problem + patch" edits to your draft and merges the ones you tick, instead of rewriting it. |
| [`dsh-better-input`](https://github.com/DIAG5/dsh-better-input) | An input-enhancement suite: voice input, prompt optimization, prompt templates, file→Markdown, OCR. |
| **dsh-prompt-tune** (this) | The smallest one: one button, three states, no settings page, no preview panel, no history. Zero dependencies, zero build step, zero install scripts, 25 tests. |

If you want previews, strategies, and configuration, take one of the others. If
you want the narrowest thing that only ever touches your draft when the draft has
not changed since the request started — and that you can read end to end in a few
minutes — this is it.

## License

[MIT](./LICENSE)
