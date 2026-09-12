# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-12

First public release. A composer control that rewrites the unsent draft with the
model DSH is already configured with, and restores the original on a second click.

### Added

- **Composer control** in the `conversation.input.left` slot (icon-only, with
  `aria-label` and `title`): `optimize` → `loading` → `undo`, disabled while the
  draft is empty or the composer is busy.
- **Host route** `POST /dsh-prompt-tune/api/optimize`, registered on the shared
  `webServer`, answering `{ optimized }` and a semantic status per failure:
  `400` bad body or empty prompt, `413` over 20000 characters, `503` no default
  model configured, `502` empty model answer, `504` timeout, `500` otherwise.
- **Model call** through the harness itself: `agentDefaultModel.currentSelection()`
  picks the route and `ctx.llm.stream()` runs it with reasoning off, temperature
  0.3, a 2048-token output cap, and a 60-second abort signal.
- **Draft protection**: a result is written back only if the draft still equals
  the snapshot the request started from; a stale result is discarded silently.
  Clearing or sending the draft retires the undo target and the control returns
  to idle.
- **Failure surfacing**: the reason appears on the control's `title` with a brief
  warning colour instead of only reaching the console.
- **Client-side timeout**: the browser stops waiting after 45 seconds and aborts
  the request, so a stalled model call cannot leave the control spinning.
- **Tests** (`node:test`, 25 cases): the host route end to end against a fake
  context, plus the browser half through a minimal React-shaped runtime —
  module contract, slot registration, state machine, write-back, staleness,
  failure, timeout, and the rendered element tree.

### Notes

- No build step and no runtime dependencies: the browser half is hand-written CJS
  in the harness module-loader envelope and only requires platform seed modules
  (`react`, `@deepseek-ai/dsh-client-ui-primitives`); the host half is plain ESM
  importing `@deepseek-ai/dsh-llm` from the host.
- Verified against DeepSeek Harness `0.1.2-rc.1` (plugin load, host route, and the
  real end-to-end model call on a running `dsh web` instance).

[Unreleased]: https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune/releases/tag/v0.1.0
