# LINTER — 代码风格与静态检查规范

本项目所有代码提交前必须通过本文所述检查。CI 与本地保持一致。

## 1. Rust（`backend/`）

工具：`rustfmt` + `clippy`（默认 `cargo` 组件，无需额外安装）

```bash
cargo fmt --all                      # 格式化（提交前必须跑）
cargo clippy --all-targets -- -D warnings   # lint，警告视为错误
```

规则约定（在默认 clippy 之上）：

| 规则 | 说明 |
|------|------|
| `clippy::unwrap_used` = deny | 业务代码禁止 `unwrap()`，仅 `#[cfg(test)]` 中允许；用 `expect("原因")` 或返回 `Result` |
| `clippy::all` = deny | 默认全开 |
| 无 `unsafe` | 全项目不允许 `unsafe`（无必要场景）；如确需，必须 `// SAFETY:` 注释 + code review |
| 错误处理 | 模块内 `thiserror` 定义错误类型，`main`/边界层用 `anyhow`；禁止 `String` 当错误类型 |
| 异步 | handler 不做阻塞调用；阻塞操作用 `tokio::task::spawn_blocking` |
| 共享状态 | 锁持有范围最小化；锁内不得 `.await`（clippy `await_holding_lock` = deny） |

## 2. TypeScript / React（`frontend/`）

包管理器统一使用 **pnpm**（禁止混用 npm/yarn；依赖安装 `pnpm install`，提交 `pnpm-lock.yaml`）。

工具：**oxlint**（配置见 `frontend/.oxlintrc.json`）

```bash
pnpm lint        # oxlint
pnpm typecheck   # tsc -b（提交前必须通过）
```

规则约定：

| 规则 | 说明 |
|------|------|
| `no-explicit-any` = error | 用具体类型或 `unknown` 收窄；API 类型手写 interface |
| hooks 规则 | `react-hooks/exhaustive-deps` = error，禁止用 eslint-disable 掩盖依赖问题 |
| 组件 | 函数组件 + hooks，不写 class 组件；默认导出仅用于页面级组件 |
| 状态 | 跨页面共享才进 zustand store，组件局部状态不全局化 |
| 命名 | 组件/类型 PascalCase，函数/变量 camelCase，文件名与默认导出同名 |
| 无未使用导出 | `no-unused-vars` = error |

## 3. 通用

- **TDD 强制**：所有功能开发遵循红-绿-重构循环（见 §4），测试先行；
- **测试必须通过**：后端 `cargo test`、前端 `pnpm test`（如引入测试框架）全部绿色才算通过；核心逻辑（二维码校验、房间状态机、限流）必须有单元测试覆盖；
- 提交信息遵循 Conventional Commits（`feat:` / `fix:` / `docs:` / `refactor:` / `chore:`）；
- 文档（`docs/*.md`）改动需同步更新 `CHANGELOG.md`；
- 新增依赖需说明理由，优先选维护活跃、无重复功能的库。

## 4. TDD 工作流（红-绿-重构）

所有功能代码按以下循环开发，**禁止先写实现再补测试**：

```
红（Red）        先写失败的测试——测试描述的是"期望行为"而非"实现细节"
   ↓
绿（Green）      用最简单的实现让测试通过，不追求优雅
   ↓
重构（Refactor） 消除重复、改善命名、抽公共逻辑，测试保持绿色
```

**落地规则：**

1. **提交粒度**：一个红-绿-重构循环对应一个提交（或 squash 前的一次提交），提交信息如 `test(auth): 签名 cookie 过期校验` / `feat(auth): 实现 cookie 签名`；
2. **测试优先级**（每个模块按此顺序写测试）：
   - 后端：核心纯逻辑（签名 cookie、二维码校验、消息队列淘汰、限流）→ HTTP 层（axum `tower::ServiceExt::oneshot` 打路由）→ 外部客户端（mock HTTP，mockito/wiremock）；
   - 前端：纯函数与 store（vitest）→ 组件交互（testing-library）；
3. **测试即文档**：测试名用行为描述（`expired_token_is_rejected` 而非 `test_verify_2`）；
4. **禁止事项**：
   - 禁止为通过测试而在实现里硬编码测试数据；
   - 禁止删除/跳过失败测试来"变绿"（`#[ignore]` 必须附 issue 说明）；
   - 禁止 mock 你不拥有的东西（mock 雨课堂 HTTP 边界，不 mock reqwest 内部）；
5. **外部接口先实测后固化**：如雨课堂登录实测（.temp/scripts/），用实测结果作为测试的期望值。

## 5. Git 工作流（双分支模型）

分支模型：`main`（生产，受保护）+ `dev`（集成分支，受保护）。

```
dev ──▶ feature/x ──▶ dev（合并）──▶ push ──▶ CI 通过 ──▶ PR dev→main ──▶ 评审 ──▶ 合并 main
```

**规则：**

1. 每次开发**必须**从最新 `dev` 拉出新分支：`git switch dev && git pull && git switch -c <branch>`；
2. **禁止**直接向 `main` 或 `dev` push（两分支均设保护，仅允许 PR 合并）；
3. 分支命名（前缀 + `/` + 简短小写连字符描述）：
   - `feat/<scope>-<desc>`：新功能，如 `feat/room-password`
   - `fix/<scope>-<desc>`：缺陷修复，如 `fix/ws-reconnect`
   - `docs/<desc>`：文档，如 `docs/spec-update`
   - `chore/<desc>`：构建/依赖/杂项，如 `chore/deps-update`
4. 完成后提 PR **先合并到 `dev`**（自测 + 至少一次本地 CI 等价检查）；
5. `dev` push 后 CI 必须全绿；准备发版时提 **PR `dev` → `main`**，通过评审后合并；
6. 合并方式：feature → `dev` 用 squash；`dev` → `main` 用 merge commit（保留版本边界）；
7. 合并后删除 feature 分支；`main` 合并后打 tag（`v0.x.y`）。

## 6. PR 模板与 CI

- PR 描述使用 `.github/pull_request_template.md` 模板；
- CI（`.github/workflows/ci.yml`）在 push 到 `main`/`dev` 和所有 PR 上运行：
  - 后端：`cargo fmt --check`、`cargo clippy -D warnings`、`cargo test`
  - 前端（pnpm）：`eslint`、`tsc --noEmit`、测试、构建
- **CI 不绿不允许合并**（分支保护强制）。

## 7. 落地方式

- 后端：`Cargo.toml` 中配置 `[lints.clippy]`（`unwrap_used = "deny"` 等），使 `cargo clippy` 直接生效；
- 前端：使用脚手架自带的 `oxlint`（配置 `frontend/.oxlintrc.json`），规则按 §2 调整；
- 后续可加 pre-commit 钩子或 CI workflow 强制执行（M6 阶段）。
