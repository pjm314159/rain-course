/// 扫码引擎：BarcodeDetector 优先；不支持时统一用 jsQR（相机逐帧 / 图片画布解码）
/// （曾用 @zxing/browser 兜底：静态图与视频流解码实测对整数倍缩放的二维码漏检，已移除，docs/SPEC.md §3.2.2）
export type ScanEngine = 'native' | 'jsqr'

interface NativeDetector {
  // 运行时接受任意 ImageBitmapSource（img/video/canvas），DOM lib 类型过窄故自行声明
  detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>>
}

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => NativeDetector
  }
}

export function scanEngine(): ScanEngine {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window ? 'native' : 'jsqr'
}

export interface ScannerHandle {
  stop: () => void
}

/** 上传图片的大小上限（5MB，超出直接拒绝） */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** 图片解码前的最大边长：超大照片先等比缩小，控制耗时与内存 */
const MAX_DECODE_EDGE = 2048

/** 从选择的图片中本地识别第一个二维码；识别不出/超限抛错（图片不离开浏览器） */
export async function decodeQrFromImage(file: File): Promise<string> {
  if (file.size > MAX_IMAGE_BYTES) throw new Error('图片超过 5MB，请压缩后重试')
  const objectUrl = URL.createObjectURL(file)
  try {
    const text = await decodeImage(objectUrl)
    if (!text) throw new Error('未能从图片中识别出二维码')
    return text
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

async function decodeImage(objectUrl: string): Promise<string> {
  const img = new Image()
  img.src = objectUrl
  await img.decode()
  if (scanEngine() === 'native') {
    const detector = new window.BarcodeDetector!({ formats: ['qr_code'] })
    const codes = await detector.detect(img)
    const native = codes.find((c) => c.rawValue)?.rawValue
    if (native) return native
  }
  return decodeByJsQr(img)
}

/** 画布取 ImageData 交给 jsQR（纯 JS，对缩放/旋转/亮度变化稳健） */
async function decodeByJsQr(img: HTMLImageElement): Promise<string> {
  const scale = Math.min(1, MAX_DECODE_EDGE / Math.max(img.naturalWidth, img.naturalHeight))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return ''
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { default: jsQR } = await import('jsqr')
  return jsQR(data, canvas.width, canvas.height)?.data ?? ''
}

/** 相机帧解码前的最大边长：大分辨率帧先等比缩小，控制每帧解码耗时 */
const CAMERA_DECODE_EDGE = 1280

/** 每帧解码间隔（ms）：识别失败/内容被拒时继续下一帧 */
const FRAME_INTERVAL_MS = 300

/**
 * 打开相机并持续识别二维码。
 * onDetected 返回 true 表示接受该结果并停止扫描；返回 false 则忽略该内容、继续扫下一帧
 * （例如内容不是雨课堂签到码时，调用方给出提示但不中断扫码）。
 */
export async function startQrScan(
  video: HTMLVideoElement,
  onDetected: (text: string) => boolean,
): Promise<ScannerHandle> {
  const stream = await openCamera(video)
  try {
    return scanEngine() === 'native'
      ? await startNative(stream, video, onDetected)
      : await startJsQr(stream, video, onDetected)
  } catch (e) {
    stopStream(stream)
    throw e
  }
}

async function openCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = navigator.mediaDevices?.getUserMedia
    ? await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    : null
  if (!stream) throw new Error('无法访问相机，请使用手动输入')
  video.srcObject = stream
  await video.play()
  return stream
}

function stopStream(stream: MediaStream) {
  stream.getTracks().forEach((t) => t.stop())
}

async function startNative(
  stream: MediaStream,
  video: HTMLVideoElement,
  onDetected: (text: string) => boolean,
): Promise<ScannerHandle> {
  const detector = new window.BarcodeDetector!({ formats: ['qr_code'] })
  let stopped = false
  let raf = 0
  const tick = async () => {
    if (stopped) return
    try {
      const codes = await detector.detect(video)
      const first = codes.find((c) => c.rawValue)
      if (first && onDetected(first.rawValue)) {
        stop()
        return
      }
    } catch {
      // 单帧解码失败忽略，继续下一帧
    }
    raf = requestAnimationFrame(() => void tick())
  }
  function stop() {
    stopped = true
    cancelAnimationFrame(raf)
    stopStream(stream)
  }
  void tick()
  return {
    stop: () => {
      stop()
    },
  }
}

/** jsQR 逐帧解码：定时把视频帧画到画布上取 ImageData 识别（纯 JS，对缩放/旋转/亮度稳健） */
async function startJsQr(
  stream: MediaStream,
  video: HTMLVideoElement,
  onDetected: (text: string) => boolean,
): Promise<ScannerHandle> {
  const { default: jsQR } = await import('jsqr')
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('无法创建画布上下文')
  let stopped = false
  let timer = 0
  const tick = () => {
    if (stopped) return
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
      const scale = Math.min(1, CAMERA_DECODE_EDGE / Math.max(video.videoWidth, video.videoHeight))
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(frame.data, canvas.width, canvas.height)
      if (code !== null && code.data !== '' && onDetected(code.data)) {
        stop()
        return
      }
    }
    timer = setTimeout(tick, FRAME_INTERVAL_MS)
  }
  function stop() {
    stopped = true
    clearTimeout(timer)
    stopStream(stream)
  }
  tick()
  return { stop }
}
