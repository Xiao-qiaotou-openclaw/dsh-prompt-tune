# Submission to the DSH plugin register

The plugin market (`dshmarket`) and the directory sites do **not** read a list from
this repository. They read the curated register
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin),
which is regenerated from `data/plugins/*.yml` — one YAML file per plugin. Getting
listed is a one-file pull request there.

## 1. The entry file

Path: `data/plugins/Xiao-qiaotou-openclaw__<repo>.yml` — the filename is the GitHub owner and
repository joined by `__`. Ready to copy from
[`dsh-prompt-tune.yml`](./dsh-prompt-tune.yml) in this directory; replace
`Xiao-qiaotou-openclaw` with the real GitHub owner in **both** the filename and the file body.

```yaml
url: https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune
name: Xiao-qiaotou-openclaw/dsh-prompt-tune
category: ui
description:
  en: One-click prompt optimizer in the DSH Web composer: rewrites the unsent draft through the configured model and restores the original on a second click.
  zh: DSH Web 输入框里的一键提示词优化按钮：用已配置的模型重写未发送的草稿，再点一次还原原文。
```

Notes on the format, from the register's own `contributing.md`:

- `url` must match the repository exactly; `name` is the link text in the list.
- Only `description.en` is required; `zh` may be omitted (a maintainer fills it in).
- **A description containing `: ` (colon + space) must be quoted**, or YAML parses
  it as a nested key. The entry above deliberately avoids the pattern.
- `category` must be one of `agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`.
  `ui` fits a composer control; `session` (where the closest sibling plugin
  [`dsh-prompt-enhance`](https://github.com/rongxingda/dsh-prompt-enhance) sits) is
  also defensible, and maintainers re-file a near miss rather than reject it.
- No marketing language, and every claim is checked against the source.
- The `install` line is derived by the site (npm if published, otherwise the
  GitHub spec), so it is not part of the entry file.

## 2. Prerequisites (CI checks these, in this order)

| Check | Status for this repository |
| --- | --- |
| At most 3 entries per PR | 1 entry |
| `package.json` declares `dsh.bundle` | ✅ `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — declaring only `dsh.client` is the most common rejection |
| `cordis.patch.yml` exists next to it | ✅ `- insert: [{ id: dsh-prompt-tune, name: dsh-prompt-tune }]` |
| Repository is **at least 1 day old** | ⚠️ checked automatically — if the repository was created today, open the PR tomorrow (nothing is held against a resubmission) |
| Real, working code (not a placeholder or README-only) | ✅ two halves plus 25 tests |
| Repository carries the `dsh-plugin` topic | set it on GitHub: repository page → About → Topics |
| Description accurate | the entry above claims only what the code does |

## 3. Open the pull request

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`.
2. Add the single file at `data/plugins/Xiao-qiaotou-openclaw__dsh-prompt-tune.yml`.
3. Open a PR titled `Add Xiao-qiaotou-openclaw/dsh-prompt-tune` — **do not edit either README
   by hand**: they are generated from `data/plugins/*.yml` on merge.

Suggested PR body:

```markdown
Adds `dsh-prompt-tune` — a one-click prompt optimizer for the DSH Web composer.

- Composer tool-row control (`conversation.input.left`) with three states:
  optimize → optimizing → undo.
- Host route `POST /dsh-prompt-tune/api/optimize` calls `ctx.llm.stream()` with
  the model from `agent-default-model`.
- Writes back to the draft only when the draft still matches the request
  snapshot; failures never modify the composer.
- No build step, no runtime dependencies, no install-time scripts; the host and
  browser halves ship as written.
- 25 `node:test` cases (12 host route, 13 browser half).

Repository: https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune
```

## 4. Optional: publish to npm first

The register prefers a prebuilt npm package (installs skip the `allowBuilds`
build-approval step), and the market offers it instead of the source build. This
package needs no build, so a GitHub install is already cheap — but an npm release
still gives the best install experience.

```sh
npm publish --access public
```

Then the register's generated `install` line points at the npm name.
