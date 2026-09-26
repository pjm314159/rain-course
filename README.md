# rain-course

雨课堂签到助手 Web 版

- 作者：pjm314159
- 许可证：GPL-3.0-or-later

## 文档

- [需求规格（SPEC）](docs/SPEC.md)
- [技术设计（DESIGN）](docs/DESIGN.md)
- [变更记录](docs/CHANGELOG.md)
- [代码规范与工作流](docs/LINTER.md)

## 技术栈

Rust (axum) · Vite + React · Nginx · Docker Compose

## 开发

```bash
# 后端
cd backend && cargo build

# 前端（pnpm）
cd frontend && pnpm install && pnpm dev
```
