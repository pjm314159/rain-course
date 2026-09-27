import { describe, expect, it } from 'vitest'
import { isYuketangSignUrl } from './sign-url'

// 用例与后端 backend/src/signin/validate.rs 的测试一一对齐
describe('isYuketangSignUrl', () => {
  it('接受白名单 HTTPS 域名（host 大小写不敏感）', () => {
    for (const u of [
      'https://www.yuketang.cn/c/abc?x=1',
      'https://pro.yuketang.cn/',
      'https://changjiang.yuketang.cn/v/lesson/1',
      'https://huanghe.yuketang.cn',
      'https://WWW.YUKETANG.CN/c/abc',
      'https://www.yuketang.cn:443/c', // 显式 443 与缺省等价
    ]) {
      expect(isYuketangSignUrl(u), u).toBe(true)
    }
  })

  it('拒绝非 URL、非 HTTPS、仿冒域、裸域、IP、端口、userinfo 与其它站点', () => {
    for (const u of [
      '',
      'not a url at all',
      '随机中文串xyz',
      'http://www.yuketang.cn/c',
      'ftp://www.yuketang.cn/c',
      'javascript:alert(1)',
      'https://evil-yuketang.cn/c',
      'https://www.yuketang.cn.evil.com/c',
      'https://yuketang.cn/c',
      'https://1.2.3.4/c',
      'https://[::1]/c',
      'https://www.yuketang.cn:8080/c',
      'https://user@www.yuketang.cn/c',
      'https://u:p@www.yuketang.cn/c',
      'https://pjm31.online', // 实测误扫的普通二维码
    ]) {
      expect(isYuketangSignUrl(u), u).toBe(false)
    }
  })

  it('拒绝超长内容（与后端 2048 字节上限一致）', () => {
    expect(isYuketangSignUrl(`https://www.yuketang.cn/${'a'.repeat(2048)}`)).toBe(false)
  })
})
