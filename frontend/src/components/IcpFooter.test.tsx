import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

/** 配置项在模块加载时读取，故需重置模块后动态导入以覆盖不同环境值 */
async function renderFooter(icpBeian: string) {
  vi.resetModules()
  vi.stubEnv('VITE_ICP_BEIAN', icpBeian)
  const { default: IcpFooter } = await import('./IcpFooter')
  return render(<IcpFooter />)
}

describe('IcpFooter ICP 备案页脚', () => {
  it('未配置备案号时零 DOM 痕迹', async () => {
    const { container } = await renderFooter('')
    expect(container.innerHTML).toBe('')
  })

  it('配置备案号后渲染号码并链接工信部', async () => {
    const { container } = await renderFooter('京ICP备00000000号-1')
    const link = container.querySelector('a')
    expect(link?.textContent).toBe('京ICP备00000000号-1')
    expect(link?.getAttribute('href')).toBe('https://beian.miit.gov.cn/')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noreferrer')
  })
})