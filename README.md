<div align="center">

# @ddv12138/dsh-hash-edit

**Hash-anchored read / replace / undo for DeepSeek Harness (DSH)**
**为 DeepSeek Harness (DSH) 开发的哈希锚行读写 / 替换 / 撤销插件**

_Ported from [`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) · 移植自 pi-hashline-edit-pro_

</div>

[![CI](https://img.shields.io/github/actions/workflow/status/ddv12138/dsh-hash-edit/ci.yml?branch=main&label=CI)](https://github.com/ddv12138/dsh-hash-edit/actions) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## What it does · 它能做什么

Every line of a text file carries a **stable 3-character base-62 anchor**. Tools address lines by
anchor instead of line number or raw text, so edits never corrupt the file: **stale or ambiguous anchors
are rejected — never fuzzy-matched**. Undo persists across restarts.

每个文本文件的每一行都带有一个**稳定、唯一的 3 位 base-62 锚点**。工具通过锚点（而非行号或原文）定位行，
因此编辑绝不会损坏文件：**过期或歧义锚点一律拒绝——绝不模糊匹配**。撤销记录跨重启持久化。

---

## Install · 安装

This is a DSH **[bundle](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)** —
an npm package that ships a `cordis.patch.yml` layer. A bundle is what you author and distribute; a user
installs it into a **profile**:

这是 DSH 的 **[bundle（插件包）](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)**——
一个携带 `cordis.patch.yml` 配置层的 npm 包。插件作者只发布 bundle；用户把它安装进一个 **profile**：

```sh
# from a local checkout 从本地检出安装
dsh plugin --profile demo add ./dsh-hash-edit

# from GitHub 从 GitHub 安装
dsh plugin --profile demo add github:ddv12138/dsh-hash-edit

# from npm 从 npm 安装
dsh plugin --profile demo add @ddv12138/dsh-hash-edit
```

Mounting the bundle's patch inserts the `@ddv12138/dsh-hash-edit` row, which **takes over** editing (see next section).
Because you install it per profile, it works from **any preset / profile** — this is how "usable from any
preset" is realized in DSH's model.

把该 bundle 的 patch 装载进 profile 后，会插入 `@ddv12138/dsh-hash-edit` 插件行，从而**接管**编辑（见下节）。
由于是按 profile 安装，它能在**任意 preset / profile** 下工作——这正是 DSH 模型里“任何 preset 都能用”的实现方式。

---

## Takeover · 接管行为(pi-aligned · 对齐 pi)

When mounted, the plugin (package main `index.js` ⇐ `src/takeover.js`) does the following **per profile /
agent scope**:

插件装载后（包入口 `index.js` ⇐ `src/takeover.js`）在**每个 profile / agent 作用域**内执行以下动作：

| Behavior 行为 | Detail 说明 |
|---|---|
| Shadow `read` 遮蔽内置 read | registers a hash-anchored `read` (scoped registration shadows the built-in) 注册哈希锚行 `read`（作用域注册遮蔽内置） |
| `replace` & `undo_last_replace` | pi-faithful single-edit replace + persisted single-level undo 单次编辑替换 + 持久化单级撤销 |
| Hide built-in `edit` 隐藏内置 edit | `tools.restrict({ deny: ['edit'] })` — session-scoped 会话级隐藏 |
| Intercept `write` 拦截 write | `tools/result` appends an **auto-read** anchor block so anchors stay fresh 追加 **auto-read** 锚点块，锚点不再过期 |
| Usage discipline prompt 使用纪律 prompt | one edit per file per message; copy bare hashes only 一个文件一条消息只改一次；只拷贝纯净哈希 |

> **Why in a profile? → 为什么放在 profile？** DSH's `tools.restrict` and `tools/result` are **agent-scoped**,
> so the takeover lives in the mounted plugin rather than a global host row. A host plugin can only register
> tools.

> DSH 的 `tools.restrict` 与 `tools/result` 都是 **agent 作用域**的，所以“接管”放在被装载的插件里，而不是全局
> host 行。Host 插件只能注册工具，无法做每会话的接管。

If you only want the tools (no takeover), install the `core` plugin instead:
如果只想要工具（不要接管），改用 `core` 插件：

```yaml
- id: hashline-core
  name: '@ddv12138/dsh-hash-edit/core'
```

---

## Tools · 工具

| Tool 工具 | Purpose 用途 |
|---|---|
| `read` (hashline) | line → `HASH│content`, offset/limit paging; records the *served range* 行级输出 + 分页，记录*已展示区间* |
| `replace` | `remove_from` / `remove_to` (bare 3-char hashes) + `replacement_text`（`\n` 分隔；`""` 删除区间）; **one edit per call** 一次调用只改一处 |
| `undo_last_replace` | reverts the most recent replace, byte-exact (content + BOM + endings + anchors) 撤销最近一次替换，字节级还原 |

Rejections, **never fuzzy-match** · 拒绝规则，**绝不模糊匹配**：

| Code 码 | Meaning 含义 |
|---|---|
| `[E_STALE_ANCHOR]` | anchor no longer exists in the current file 当前文件已无此锚点 |
| `[E_AMBIGUOUS_ANCHOR]` | anchor matches >1 line 锚点对应多行 |
| `[E_RANGE_STALE]` | file changed or the range was never shown 文件已变或该区间未被展示 |
| `[E_BAD_REF]` | anchor not a bare 3-char hash 锚点不是纯净 3 位哈希 |
| `[E_UNDO_STALE]` | file changed since the last replace 上次替换后文件被改动 |
| `[E_FILE_TOO_LARGE]` | > 238,328 lines or > 100 MB 超行数/字节上限 |

---

## Anchoring · 锚定算法

- `canon(line) = line.replace(/\r/g, '').trimEnd()`
- `xxHash32(canon, seed 0) >>> 14 % 238328` → a 3-char base-62 (`A-Za-z0-9`) anchor
  （已验证与 `xxhashjs` 参考实现逐位一致 · verified bit-exact vs the `xxhashjs` reference）
- Collisions resolved via a bitset probing with stride `3907 = 62²+62+1` (coprime with the anchor space) —
  **unique anchors by construction** 冲突以步长 `3907` 互质位图探测消解，**构造性唯一**
- Stable mapping 稳定映射：survivors keep anchors by nearest-position match; a removed line's anchor is
  reused when identical text is re-inserted; new lines get fresh anchors
  存活行按最近位置保留锚点；相同文本重新插入复用旧锚点；新行发新锚点
- File caps 文件上限：≤ 238,328 lines 行 && ≤ 100 MB

---

## Store · 存储

`.dsh-hash-edit/store.json` in the project workspace (gitignored) · 位于项目工作区（已 gitignore）：

- `snap[absPath]` — current line/hash snapshot + last-served range + checksum 当前行/哈希快照 + 已展示区间 + 校验和
- `undo[absPath]` — single-level undo record per file 每文件单级撤销记录

---

## Dev & CI · 开发与自动化测试

```sh
npm ci
npm test          # node --test → runs test/ (engine unit + read→replace→undo integration)
```

`.github/workflows/ci.yml` runs `npm test` on **Node 20 & 22 for every push / PR**（每次 push / PR 自动验证）。

Test files · 测试文件：`test/xxhash32.test.js`（xxHash32 位精确）、`test/anchoring.test.js`（唯一性/稳定性/复用）、
`test/replace-undo.test.js`（读→改→撤字节还原、BOM/CRLF、错误码）。

---

## Repo layout · 仓库结构

```
index.js             # main plugin (takeover) main 入口（接管）
cordis.patch.yml     # the bundle layer applied by dsh plugin 插件配置层
src/engine.js        # pure, dependency-free engine 核心引擎（无依赖）
src/plugin.js        # host-core plugin (./core export) 核心工具插件
src/takeover.js      # pi-aligned takeover plugin 接管插件
test/                # node:test suite 测试套件
docs/adr/            # architecture decision records 架构决策记录
```

## References · 参考

- [CONTEXT.md](CONTEXT.md) — glossary 术语表
- [docs/adr/0001-workspace-store.md](docs/adr/0001-workspace-store.md) — why the store lives in the project
  workspace 为何存储放在项目工作区
- [DSH bundle/publish guide](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) —
  the official packaging convention this repo follows 本项目遵循的官方打包规范
- Upstream 上游：[`pi-hashline-edit-pro`](https://pi.dev/packages/pi-hashline-edit-pro) (MIT), original
  [`pi-hashline-edit`](https://github.com/yugimob/pi-hashline-edit) by RimuruW

---

## License · 许可

[MIT](LICENSE)
