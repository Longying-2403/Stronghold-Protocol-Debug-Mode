// ui/debugMode.js — the way into a debug room (DESIGN §27, a remake tool for testing): the 调试模式 switch of the
// settings (kept per browser, `sp.pref.debugMode`, off by default), the DBUG key (shared/constants.js DEBUG_ROOM_CODE),
// the confirmation every entry asks for, and the requests behind it.
//
//   * DBUG typed into 加入同盟 (or a `?room=DBUG` link): with the switch on and a server that opens debug rooms
//     (welcome.debugRooms — SP_DEBUG=0 turns them off), the player confirms 「你即将进入 DEBUG Mode 房间」 and the client
//     sends room.create { mode, difficulty, debug: true } — a new debug room with an ordinary key of its own.
//   * Any other key: room.join / room.spectate as usual; a debug room answers DEBUG_CONFIRM, the same confirmation is
//     asked, and the request goes again with `debugAck: true`. Joining a teammate's debug room needs no switch.

import { DEBUG_ROOM_CODE, ERR } from '../../../shared/constants.js';
import { createStore, useStore, loadPref, savePref, store } from '../store.js';
import { html, confirmDialog } from './components.js';
import { toast } from './toasts.js';
import { net } from '../net.js';
import { t } from '../../../shared/i18n.js';

/** The 调试模式 switch: { enabled } (this browser only). */
export const debugPrefStore = createStore({ enabled: loadPref('debugMode', false) === true });
debugPrefStore.subscribe((s) => savePref('debugMode', !!s.enabled));

/** Turn the 调试模式 switch on / off. @param {boolean} on */
export const setDebugEnabled = (on) => debugPrefStore.set({ enabled: !!on });

/** Preact hook: the 调试模式 switch. */
export const useDebugEnabled = () => useStore((s) => !!s.enabled, Object.is, debugPrefStore);

/** Whether the server opens debug rooms (welcome.debugRooms; assumed until a welcome says otherwise). */
export const serverDebugRooms = (s = store.get()) => s?.ui?.debugRooms !== false;

/** Whether a key the player entered is the debug room key. @param {unknown} code */
export const isDebugCode = (code) => typeof code === 'string' && code.trim().toUpperCase() === DEBUG_ROOM_CODE;

/** The confirmation before any entry into a debug room. @returns {Promise<boolean>} */
export function confirmDebugEntry() {
  return confirmDialog({
    title: t('进入 DEBUG Mode'), micro: 'DEBUG MODE', tone: 'amber', okText: t('进入'), cancelText: t('取消'),
    text: html`<p class="modal__text"><b>${t('你即将进入 DEBUG Mode 房间。')}</b></p>
      <p class="modal__text">${t('调试房间用于快速测试：开局前可以指定战场、领袖、禁用盟约、特训敌人和起始状态，局内可以修改资金、调度中心等级、生命值和盟约层数，控制作战速度，并直接取用干员和道具。这里的对局不是正式模拟。')}</p>`,
  });
}

/**
 * DBUG: a new debug room of the lobby's mode and difficulty, after the server and the switch allow it and the player
 * confirmed. Resolves true once the server accepted it, false when nothing was sent; a refused request rejects.
 * `request` / `confirm` stand in for the socket and the dialog in tests.
 * @param {{ mode: 'solo'|'coop', difficulty: string, request?: (t: string, f: object) => Promise<any>, confirm?: () => Promise<boolean> }} o
 */
export async function enterDebugRoom({ mode, difficulty, request = (type, fields) => net.request(type, fields), confirm = confirmDebugEntry }) {
  if (!serverDebugRooms()) { toast(t('此服务器已关闭调试模式'), 'warn'); return false; }
  if (!debugPrefStore.get().enabled) { toast(t('请先在「设置」中开启调试模式，再输入 {code}', { code: DEBUG_ROOM_CODE }), 'warn'); return false; }
  if (!(await confirm())) return false;
  await request('room.create', { mode, difficulty, debug: true });
  return true;
}

/**
 * room.join / room.spectate of a key; a debug room (DEBUG_CONFIRM) is entered only after the player confirmed it.
 * Resolves true once in, false when the player declined; any other refusal rejects.
 * @param {'room.join'|'room.spectate'} type
 * @param {string} code
 * @param {(t: string, f: object) => Promise<any>} [request]
 * @param {() => Promise<boolean>} [confirm]
 */
export async function joinWithAck(type, code, request = (tp, fields) => net.request(tp, fields), confirm = confirmDebugEntry) {
  try {
    await request(type, { code });
    return true;
  } catch (err) {
    if (err?.code !== ERR.DEBUG_CONFIRM) throw err;
    if (!(await confirm())) return false;
    await request(type, { code, debugAck: true });
    return true;
  }
}
