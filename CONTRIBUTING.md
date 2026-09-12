# 贡献指南

感谢你愿意改进这个插件。这个仓库刻意保持"零依赖、零构建"：**没有打包器、没有运行时依赖、没有安装期脚本**，所以贡献流程比多数插件仓库短。改动前请先读完本文的「两条硬规则」。

## 两条硬规则

1. **不能引入构建步骤**。浏览器半边是手写的 CJS，包在 DSH 前端要求的 `window.__ModuleLoader__.load({ id, factory })` 信封里；宿主半边是普通 ESM。两端都是"仓库里是什么，用户装到的就是什么"。所以不要引入 TS/JSX 源码 + 编译产物的双层结构（那会带来"产物与源码不一致"的整类问题），直接写可运行的 JS。
2. **不能引入依赖**。`dependencies` 必须保持为空；`peerDependencies` 里的每一项都必须在 `peerDependenciesMeta` 中标记 `optional: true`（pnpm 会自动安装非可选 peer，而这些包在运行时由宿主提供）。禁止 `preinstall` / `install` / `postinstall` / `prepare` 脚本——pnpm ≥ 10 默认拦截它们，用户会装不上。

`npm run check` 会强制校验上面两条，并检查包名与浏览器 bundle 注册的模块 id 是否一致、`exports["./client"]` 与 `dsh.bundle.patch` 指向的文件是否存在。

## 环境要求

- Node.js `^22.19.0 || >=24.0.0`（与 DSH 一致）
- 一个可运行的 DSH（`dsh >= 0.1.2-rc.1`），用于真机验证

```bash
npm install          # 只装开发期的 @deepseek-ai/dsh-llm（宿主测试要解析它）
npm run verify       # check + 全部测试，提交前请确保通过
```

## 测试

```bash
npm run test:client   # 浏览器半边：11+ 项，自带最小 React 运行时，无需任何 peer 包
npm run test:host     # 宿主半边：路由与模型调用参数
npm test              # 两者都跑
```

- **浏览器半边测试**用自带的「React 形状」最小运行时（`createElement` + `useState`/`useRef`/`useEffect`）直接对元素树做结构化断言，因此不依赖 `react-dom`，也不受你机器上解析到的 React 版本影响。测试里 `renderControl()` 会**经由槽位 seat** 渲染，这与 shell 的真实渲染路径一致——seat 必须通过标准 `useInput` 钩子取草稿（见下方「槽位契约」）。
- **宿主半边测试**用假 `ctx`（`effect` / `webServer.register` / `llm.stream` / `agentDefaultModel`）和假 `req`/`res` 驱动注册出来的路由，覆盖每个状态码与传给 `ctx.llm.stream` 的参数。

### 沙箱或受限环境下的注意事项

- DSH 的文件沙箱禁止子进程管道，`node --test <dir>` 会 `spawn EPERM`；请**逐个文件直接执行**（`npm test` 就是这么做的，它在任何环境都能跑）。
- 宿主半边测试需要能解析 `@deepseek-ai/dsh-llm`。如果从 profile 内的安装副本运行，它会沿 profile 的 `node_modules` 解析；从仓库根运行则需要先 `npm install`。

## 槽位契约（改客户端前务必先读）

`conversation.input.left` / `.right` 是**会话作用域**槽位，owner props 是空对象（shell 里就是 `renderSlot("conversation.input.left", {})`）。会话作用域的标准 provide 只给三样东西：

| 拿到的东西 | 来源 | 说明 |
| --- | --- | --- |
| `useInput(selector)` | `hooks: ["input"]` | 选中生效中的 `InputState`（`draft`、`phase`、`draftRev`…） |
| `useConversation(selector)` | `hooks: ["conversation"]` | 会话快照 |
| `inputActions` | `props: ["inputActions"]` | `setDraft` / `submit` / `addImages`… |

**没有 `input` 这个 prop**——只有 `conversation.input.dock` 这类带 owner props 的槽位才会拿到 `InputZone { session, input }`。写 `props.input.draft` 会永远读到空草稿（按钮一直灰着），这是本插件第一版踩过的坑。

因此组件的写法是两层：外层 seat 调 `useInput((s) => s)` 取快照并把 `draft`/`phase`/`setDraft` 当普通值传给内层控制组件，内层因此可以直接对 props 测试。

## 本地装进 profile 调试

```bash
# 1) 把仓库拷成 profile 里的真实目录（不要用符号链接：Node 会把链接解析成真实
#    路径，插件模块就跑到工作区里了，裸导入 @deepseek-ai/* 会解析失败）
#    Windows 示例：
#    Copy-Item -Recurse -Force . "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-prompt-tune"

# 2) 在 profile 的 patch 层加一行（~/.dsh/profiles/web/cordis.patch.yml）：
#    - insert:
#        - id: dsh-prompt-tune
#          name: 'dsh-prompt-tune'

# 3) 重启 dsh web，然后刷新页面
```

**改动哪一半需要重启？**

| 改了 | 生效方式 |
| --- | --- |
| `client/client.js` | **不用重启**：`dsh-client-hmr` 每 500ms stat 轮询 client bundle，变化会经 `/plugins/events` SSE 推给浏览器自动重载（保险起见 Ctrl+F5） |
| `lib/index.js`、`cordis.patch.yml`、`package.json` | 需要重启 `dsh web`（profile patch 的 `patchReload: live` 实测没有把新增的 insert 行热挂载进来） |

> 如果你确实用 `dsh plugin --profile web add <本目录>` 正式安装，**先删掉上面手工加的 insert 行**：本包自带 `dsh.bundle.patch` 会插入同一个 id，两处同时存在会让启动硬失败。

## 提交改动

1. 一个 PR 只做一件事；提交信息用祈使句，说明"改了什么、为什么"。
2. 行为改动请带上测试；修 bug 请先写出会失败的用例。
3. 提交前跑 `npm run verify`，PR 描述里贴出结果。
4. 面向用户的改动请同时更新 `README.md` 与 `README.zh.md`（两份文档地位相同），并在 `CHANGELOG.md` 的 `Unreleased` 下加一条。
5. 涉及界面文案时，请沿用 DSH 主题 token（`var(--dsw-alias-*)`）而不是硬编码颜色，并保留 `aria-label` / `title`。

## 发布（维护者）

```bash
# 1) 定版：更新 package.json 的 version，并把 CHANGELOG 的 Unreleased 改成该版本 + 日期
# 2) 全量校验
npm run verify
# 3) 打 tag（需要 git）
git tag v<version> && git push --follow-tags
# 4) 发布到 npm
npm publish
```

发布后请确认三件事：包内 `files` 白名单里没有多余文件（`npm pack --dry-run` 可预览）、`dsh plugin --profile web add <新版本>` 能装上、以及浏览器里按钮正常。

## 收录进 DSH 插件目录

插件市场（dshmarket）与目录站的列表来自精选列表 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，不是本仓库。要让插件上架，去那边提一个 PR 加一条（字段与示例见 `submission/awesome-dsh-plugin.md`）。同时请给 GitHub 仓库打上 `dsh-plugin` topic，这样会话内的插件搜索可以发现它。

## 许可

提交即表示你同意以本仓库的许可证（见 [LICENSE](./LICENSE)）授权你的贡献。
