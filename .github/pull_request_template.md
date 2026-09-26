## 变更说明

<!-- 简述本次改动内容与动机 -->

## 变更类型

- [ ] `feat` 新功能
- [ ] `fix` 缺陷修复
- [ ] `docs` 文档
- [ ] `refactor` 重构（不改行为）
- [ ] `chore` 构建/依赖/杂项

## 目标分支

- [ ] `dev`（feature/fix 常规合并）
- [ ] `main`（仅发版合并，dev → main）

## 自查清单

- [ ] 分支名符合规范（`feat/` `fix/` `docs/` `chore/` + 简短描述），基于最新 `dev` 创建
- [ ] 提交信息符合 Conventional Commits
- [ ] `cargo fmt --check` / `cargo clippy -D warnings` / `cargo test` 通过（后端改动）
- [ ] `eslint` / `tsc --noEmit` / 测试 / 构建通过（前端改动）
- [ ] 文档已同步（SPEC/DESIGN/CHANGELOG.md，如有影响）
- [ ] 无 `unwrap()`（测试代码除外）、无 `unsafe`、无 `any`
- [ ] 涉及资源分配的改动已确认上限约束（房间数/人数/消息大小/频率/存量）

## 关联 issue / 备注

<!-- 如有请填写 -->
