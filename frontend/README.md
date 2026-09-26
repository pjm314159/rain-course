# rain-course

雨课堂签到助手 Web 版：扫码签到 + WebSocket 房间分享。

- 需求规格：[docs/SPEC.md](../docs/SPEC.md)
- 技术设计：[docs/DESIGN.md](../docs/DESIGN.md)

## 技术栈

Vite + React 19 + TypeScript（React Compiler 已启用），包管理器 pnpm，Lint 使用 oxlint（配置见 `.oxlintrc.json`）。

## 开发

```bash
pnpm install
pnpm dev        # 本地开发
pnpm build      # 构建（tsc -b + vite build）
pnpm lint       # oxlint
pnpm typecheck  # tsc -b
```

## Author

pjm314159
