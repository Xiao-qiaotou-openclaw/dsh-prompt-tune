# dsh-prompt-tune

[![CI](https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiao-qiaotou-openclaw/dsh-prompt-tune/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-prompt-tune)](https://www.npmjs.com/package/dsh-prompt-tune)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
![GitHub topic: dsh-plugin](https://img.shields.io/badge/github-dsh--plugin-blue)

**给 DeepSeek Harness 输入框加一个「一键优化提示词」按钮。** 写好草稿后点一下 ✨，草稿会被 DSH 当前配置的模型改写得更清晰、更具体、更可执行，然后直接写回输入框；同一个按钮随即变成撤销按钮，一键还原你原来写的东西。

[English](./README.md) | 简体中文

## 它做什么

输入框工具行里一个只有图标的控件，三种形态：

| 形态 | 图标 | 触发条件 |
| --- | --- | --- |
| 优化 | ✨ 星形 | 草稿非空且输入框空闲（`phase === 'plain'`） |
| 优化中 | 旋转加载（禁用） | 请求进行中 |
| 撤销 | ↺ 刷新 | 上一次优化结果已写回 |

点「撤销」即还原发起优化时捕获的那份草稿。

## 值得知道的行为

- **你后来的编辑永远优先。** 只有当草稿仍等于发起请求时的快照，结果才会写回；如果你中途继续打字，结果会被静默丢弃，而不是覆盖你。
- **失败绝不动你的草稿。** 没有可用模型、提供商报错、模型返回空、超时——草稿保持原样，原因显示在控件的 `title` 上（并短暂变红），而不是只进 console。
- **它不会永远转圈。** 浏览器 45 秒后停止等待并中断请求；宿主侧 60 秒中断模型调用。
- **发送或清空草稿会作废撤销目标**，控件回到初始形态，过期的原文不可能再糊到新草稿上。
- **上限：** 草稿 20000 字符，输出 2048 tokens，关闭思考，temperature 0.3。

## 工作原理

```
点击 → 客户端通过标准 `useInput` 钩子读取实时草稿
     → POST /dsh-prompt-tune/api/optimize { prompt }
     → 宿主：agentDefaultModel.currentSelection() → ctx.llm.stream(...) → 聚合 text-delta
     → { optimized }
     → 客户端：草稿未变 ? inputActions.setDraft(optimized) : 丢弃
```

| 文件 | 角色 |
| --- | --- |
| `lib/index.js` | 宿主半边（ESM）：在共享 `webServer` 上注册一个前缀路由，用 `ctx.llm.stream` 调模型（关闭思考、temperature 0.3、输出上限 2048） |
| `client/client.js` | 浏览器半边：手写 CJS，包在 DSH 模块加载器信封里，向 `conversation.input.left` 槽注册一个控件 |
| `cordis.patch.yml` | 把本包作为一层挂进 profile |
| `scripts/check-manifest.mjs` | 发布门：包名与注册的模块 id 是否一致、`exports`/patch 指向的文件是否存在、`engines.dsh`、以及"零依赖 / 无安装期脚本"两条硬规则 |
| `test/` | `node:test` 测试：宿主路由 12 项 + 浏览器半边 13 项 |

### 零构建、零依赖、零安装期脚本

浏览器半边是手写的 `React.createElement` CJS，包在 DSH 前端要求的 `window.__ModuleLoader__.load({ id, factory })` 信封里；宿主半边是普通 ESM。两边都是"仓库里是什么，用户装到的就是什么"：GitHub 直装不需要构建，`dependencies` 保持为空，所有 peer 都是可选的，安装时不下载任何东西，也不存在会被 pnpm ≥ 10 拦下的 `postinstall` / `prepare`。

浏览器半边只需要**平台种子模块**（`react` 与 `@deepseek-ai/dsh-client-ui-primitives`，都由 harness 的模块表提供）；宿主半边从宿主导入 `@deepseek-ai/dsh-llm`。

## 环境要求

| | |
| --- | --- |
| DSH | `>= 0.1.2-rc.1`（写在 `engines.dsh`；已在 `0.1.2-rc.1` 上验证） |
| Web 客户端 | Chromium 内核浏览器——控件活在 Web 输入框里；TUI / ACP / headless 不会加载浏览器半边 |
| Node | `^22.19.0 \|\| >=24.0.0`（仅开发需要：安装期不构建、不执行任何脚本） |
| 模型 | 任意 DSH 能提供的路由。默认模型取自 `agent-default-model` 设置节，DeepSeek 官方路由或任何已配置的提供商都可用 |

## 安装

发布到 npm 之后：

```sh
dsh plugin --profile web add dsh-prompt-tune
# 然后重启 dsh web
```

从 GitHub 仓库安装：

```sh
dsh plugin --profile web add github:Xiao-qiaotou-openclaw/dsh-prompt-tune
# 然后重启 dsh web
```

也支持不经 pnpm 直接装进 profile（本插件就是这么开发调试的，详见 [CONTRIBUTING.md](./CONTRIBUTING.md)）：把仓库拷到 `<profile>/node_modules/dsh-prompt-tune`，并在 profile 的 `cordis.patch.yml` 加一行 insert：

```yaml
- insert:
    - id: dsh-prompt-tune
      name: 'dsh-prompt-tune'
```

> 实测 `patchReload: live` 不会把新增的 insert 行热挂载进来，所以**装完要重启 `dsh web`**。相反，改客户端半边**不用**重启：`dsh-client-hmr` 会轮询每个 client bundle 并把变化推给浏览器。

## 使用

1. 在输入框里写下（或保留）草稿。
2. 点 ✨ 控件；模型工作期间它会旋转。
3. 草稿被替换成优化后的提示词，控件变成 ↺。
4. 审阅、修改、发送——或点 ↺ 还原你原来的草稿。

控件是灰的，说明草稿为空（或输入框正在发送）。请求失败时，把鼠标悬停在控件上可以看到原因。

## 隐私与数据流向

你的草稿会发给 DSH 当前配置的模型提供商，走的是和普通会话请求同一条链路：浏览器 → 你自己的 `dsh` 宿主 → harness LLM 服务 → 配置的提供商。本插件不新增任何第三方端点、不写磁盘、不采集任何信息，也不会把草稿发到别处。请把它当成"把这条消息发出去"来对待：不愿发给该提供商的内容，就不要拿去优化。

## 开发

```sh
npm install          # 仅开发需要：宿主测试要用的 @deepseek-ai/dsh-llm
npm run verify       # 发布门 + 两套测试
npm test             # 两套测试
npm run check        # 只跑发布门
```

两条硬规则（禁构建、禁依赖）、输入框槽位契约、如何把本地检出装进 profile、以及"改哪一半要重启"，都在 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 卸载

```sh
dsh plugin --profile web remove dsh-prompt-tune
# 同时删掉 profile 的 cordis.patch.yml 里手工加的那行 insert
# 然后重启 dsh web
```

## 为什么还要再做一个提示词优化插件？

DSH 生态里已经有好几个，按需要选：

| 插件 | 形态 |
| --- | --- |
| [`dsh-prompt-enhance`](https://github.com/rongxingda/dsh-prompt-enhance) | 最接近的同类：输入框按钮 + 原文/增强对比面板、一键撤销、快捷键、`/enhance` 命令、实时设置页。Apache-2.0。 |
| [`dsh-prompt-polish`](https://github.com/1321928757/dsh-prompt-polish) | 6 种策略 × 3 种语言、可选会话上下文、确认弹窗、历史记录。 |
| [`dsh-prompt-refine`](https://github.com/sojo-negai/dsh-prompt-refine) | 不改写，而是给你的草稿提 3 条「问题 + 补丁」建议，勾选后合并。 |
| [`dsh-better-input`](https://github.com/DIAG5/dsh-better-input) | 输入增强套件：语音输入、提示词优化、提示词模板、文件转 Markdown、OCR。 |
| **dsh-prompt-tune**（本插件） | 最小的那个：一个按钮、三种形态、没有设置页、没有对比面板、没有历史。零依赖、零构建、零安装期脚本，25 项测试。 |

想要对比预览、多策略、可配置，就选上面那几个。想要的是"只在草稿自请求发起后没被改动过时才碰它"的最小实现，而且几分钟就能从头读到尾——那就是这个。

## 许可证

[MIT](./LICENSE)
