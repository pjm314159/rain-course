// SharedWorker 脚本：整个浏览器（同源所有标签页）只持有一条 WebSocket。
// 标签页通过 port 发送 {kind:'cmd'}，worker 广播 {kind:'frame'}/{kind:'status'} 给所有 port。
// 不支持 SharedWorker 的浏览器由 client.ts 降级为 BroadcastChannel + localStorage 选举。

import { WsConnection, type WsStatus } from './connection'
import { wsUrl, type ClientMsg, type ServerFrame } from './protocol'

/** 命令驱动连接：idle/closed 时先按需重连（start 幂等） */
function driveConn(conn: WsConnection, msg: ClientMsg): void {
  const s = conn.getStatus()
  if (s === 'idle' || s === 'closed') conn.start()
  conn.send(msg)
}

/** 标签页 ↔ 连接持有者 的消息（client.ts 同构使用） */
export type BusMsg =
  | { kind: 'cmd'; msg: ClientMsg }
  | { kind: 'frame'; frame: ServerFrame }
  | { kind: 'status'; status: WsStatus }
  | { kind: 'stop' }

// 本文件在 DOM lib 下编译，仅用最小本地声明访问 worker 全局
interface SharedWorkerGlobal {
  onconnect: ((ev: { ports: MessagePort[] }) => void) | null
}
const g = self as unknown as SharedWorkerGlobal

const ports = new Set<MessagePort>()
let conn: WsConnection | null = null

function broadcast(msg: BusMsg) {
  for (const p of ports) p.postMessage(msg)
}

function ensureConn(): WsConnection {
  if (conn) return conn
  conn = new WsConnection(
    { url: wsUrl() },
    {
      onFrame: (frame) => broadcast({ kind: 'frame', frame }),
      onStatus: (status) => broadcast({ kind: 'status', status }),
    },
  )
  conn.start()
  return conn
}

g.onconnect = (ev) => {
  for (const port of ev.ports) {
    ports.add(port)
    port.onmessage = (e: MessageEvent<BusMsg>) => {
      const data = e.data
      if (data.kind === 'stop') {
        conn?.stop()
        return
      }
      if (data.kind === 'cmd') {
        // 服务端主动断开后（如 lobby 空闲回收），下一个命令触发按需重连
        driveConn(ensureConn(), data.msg)
      }
    }
    port.start()
  }
  const c = ensureConn()
  broadcast({ kind: 'status', status: c.getStatus() })
}
