/// 签到码内容推送前预校验（与后端 signin/validate.rs 同一白名单，docs/DESIGN.md §5）
/// 仅用于扫码/相册识别后的即时反馈，避免把明显无效的内容推送到全房间；
/// 权威校验仍在后端（share_qr 不过校验不广播、/api/sign/submit 不过校验绝不出站请求）。

const ALLOWED_HOSTS = new Set([
  'www.yuketang.cn',
  'pro.yuketang.cn',
  'changjiang.yuketang.cn',
  'huanghe.yuketang.cn',
])

/** 是否为白名单内的雨课堂签到 URL（HTTPS + 域名精确匹配，大小写不敏感） */
export function isYuketangSignUrl(raw: string): boolean {
  if (raw.length === 0 || raw.length > 2048) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  // URL 会把显式 443 归一化为空端口；其余非缺省端口拒绝
  if (url.port !== '' && url.port !== '443') return false
  if (url.username !== '' || url.password !== '') return false
  // 白名单为精确域名匹配：IP 字面量、仿冒拼接域、裸域天然不命中
  return ALLOWED_HOSTS.has(url.hostname.toLowerCase())
}
