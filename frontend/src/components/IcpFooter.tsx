// ICP 备案号页脚：仅当部署方配置了 VITE_ICP_BEIAN 时才渲染，未配置时零 DOM 痕迹
// 备案号属于部署方信息，通过生产机 frontend/.env.local 注入（已 gitignore），
// 仓库不包含任何具体号码，保证开源项目可随时 git pull 更新

import { config } from '../config'

export default function IcpFooter() {
  if (!config.icpBeian) return null
  return (
    <footer className="mt-8 text-center text-xs text-muted">
      <a
        href="https://beian.miit.gov.cn/"
        target="_blank"
        rel="noreferrer"
        className="transition-colors hover:text-ink"
      >
        {config.icpBeian}
      </a>
    </footer>
  )
}