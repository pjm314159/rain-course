// 房间邀请短链工具：生成与解析（/r/{房间号}）

/** 房间邀请短链：{origin}/r/{房间号} */
export function inviteLink(room: number | null): string {
  if (room === null) return ''
  return `${globalThis.location.origin}/r/${room}`
}

/** 从用户输入解析房间号：纯数字，或短链 URL 中的 /r/{数字} */
export function parseRoomInput(v: string): number | null {
  const s = v.trim()
  if (/^\d+$/.test(s)) return Number(s)
  const m = s.match(/\/r\/(\d+)/)
  return m ? Number(m[1]) : null
}
