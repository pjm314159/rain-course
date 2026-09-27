/// 扫码引擎：相机 BarcodeDetector 优先、@zxing/browser 降级；图片 BarcodeDetector 优先、jsQR 兜底
/// （zxing 静态图解码实测对整数倍缩放的二维码会失败，故图片路径用 jsQR，docs/SPEC.md §3.2.2）
export type ScanEngine = 'native' | 'zxing'

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
  return typeof window !== 'undefined' && 'BarcodeDetector' in window ? 'native' : 'zxing'
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

/** 打开相机并持续识别二维码，检到第一个结果后回调并自动停止 */
export async function startQrScan(
  video: HTMLVideoElement,
  onDetected: (text: string) => void,
): Promise<ScannerHandle> {
  const stream = await openCamera(video)
  return scanEngine() === 'native'
    ? startNative(stream, video, onDetected)
    : startZxing(stream, video, onDetected)
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
  onDetected: (text: string) => void,
): Promise<ScannerHandle> {
  const detector = new window.BarcodeDetector!({ formats: ['qr_code'] })
  let stopped = false
  let raf = 0
  const tick = async () => {
    if (stopped) return
    try {
      const codes = await detector.detect(video)
      const first = codes.find((c) => c.rawValue)
      if (first) {
        stop()
        onDetected(first.rawValue)
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

async function startZxing(
  stream: MediaStream,
  video: HTMLVideoElement,
  onDetected: (text: string) => void,
): Promise<ScannerHandle> {
  const { BrowserMultiFormatReader } = await import('@zxing/browser')
  const reader = new BrowserMultiFormatReader()
  let stopped = false
  const controls = await reader.decodeFromStream(stream, video, (result) => {
    if (result && !stopped) {
      stopped = true
      controls.stop()
      onDetected(result.getText())
    }
  })
  return {
    stop: () => {
      stopped = true
      controls.stop()
    },
  }
}
