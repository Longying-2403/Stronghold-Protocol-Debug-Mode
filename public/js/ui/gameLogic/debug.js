// ui/gameLogic/debug.js — the pure logic of the debug rooms' UI (DESIGN §27): the room bar's summary of the settings,
// the in-match panel's targets, which operations a viewer may use now (the server decides; this only greys buttons
// out), the battle-end choices of a phase and the 取用 catalog (filters and order). Re-exported from ../gameLogic.js.

import { PHASE } from '../../../../shared/constants.js';
import { DEBUG_OPS, defaultDebugConfig } from '../../../../shared/debug.js';
import { t, tc } from '../../../../shared/i18n.js';
import { isObj, sortedPlayers } from './shared.js';

const BOSS_PHASES = new Set([PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

/** The battle-end choices (shared/debug.js END_MODES) of a phase: [] outside a battle. */
export function debugEndModes(phase) {
  if (phase === PHASE.COMBAT || phase === PHASE.UNITE) return ['natural', 'leak', 'kill'];
  if (BOSS_PHASES.has(phase)) return ['win', 'lose'];
  return [];
}

/**
 * Whether a viewer may send an operation now (the server checks it again): `why` names the reason it may not —
 * 'host' (the host's operation, or another player's state), 'dead' (the target is out), 'prep' (in a 休整期 only),
 * 'battle' (no battle to end), 'unknown'.
 * @param {string} op
 * @param {{ phase?: string|null, isHost?: boolean, self?: boolean, alive?: boolean, teamLp?: boolean }} ctx
 * @returns {{ ok: boolean, why: string|null }}
 */
export function debugOpState(op, { phase = null, isHost = false, self = true, alive = true, teamLp = false } = {}) {
  const spec = Object.hasOwn(DEBUG_OPS, op) ? DEBUG_OPS[op] : null;
  if (!spec) return { ok: false, why: 'unknown' };
  if (spec.host && !isHost) return { ok: false, why: 'host' };
  if (spec.target && !self && !isHost) return { ok: false, why: 'host' };
  if (spec.target && !alive) return { ok: false, why: 'dead' };
  if (spec.prep && phase !== PHASE.PREP) return { ok: false, why: 'prep' };
  if (op === 'lp.set' && phase !== PHASE.PREP && !(teamLp && BOSS_PHASES.has(phase))) return { ok: false, why: 'prep' };
  if (op === 'battle.end' && !debugEndModes(phase).length) return { ok: false, why: 'battle' };
  return { ok: true, why: null };
}

/** The line a greyed-out operation shows (debugOpState `why`). */
export function debugWhyText(why) {
  switch (why) {
    case 'host': return t('只有房主可以操作');
    case 'dead': return t('该博士已被淘汰');
    case 'prep': return t('休整期中才能使用');
    case 'battle': return t('作战中才能使用');
    default: return '';
  }
}

/**
 * The players the panel may act on: the viewer alone, or — the host — every player still in (AI seats included), in
 * seat order; the viewer first marked `self`.
 * @param {any} pub m.public
 * @param {string|null} myId
 * @param {boolean} isHost
 * @returns {Array<{ playerId: string, name: string, isBot: boolean, alive: boolean, self: boolean, seat: number }>}
 */
export function debugTargets(pub, myId, isHost) {
  const all = sortedPlayers(pub).filter((p) => p.status !== 'left' && typeof p.playerId === 'string');
  const list = isHost ? all : all.filter((p) => p.playerId === myId);
  return list.map((p) => ({ playerId: p.playerId, name: p.name || '', isBot: !!p.isBot, alive: p.alive !== false, self: p.playerId === myId, seat: Number.isInteger(p.seat) ? p.seat : 0 }));
}

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/**
 * The 取用 catalog: operators (`kind: 'chess'` — base records; the elite is the record's `goldenId`; 自选 slots are
 * listed apart) or items, filtered by name / codename / id (`query`), tier, bond (operators) and profession (operators),
 * ordered by tier, then the shop order (operators the shop never offers — strategy presets — after the others), then
 * name. Each entry: { id, goldenId, name, tier, special, golden }.
 * @param {any[]} records
 * @param {{ kind: 'chess'|'item', query?: string, tier?: number|null, bond?: string|null, prof?: string|null }} f
 */
export function debugCatalog(records, { kind = 'chess', query = '', tier = null, bond = null, prof = null } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!isObj(r)) continue;
    const id = kind === 'chess' ? r.chessId : r.id;
    if (typeof id !== 'string') continue;
    if (kind === 'chess' && (r.isGolden || r.isDiy)) continue;
    if (tier != null && r.tier !== tier) continue;
    if (kind === 'chess' && bond && !(Array.isArray(r.bonds) && r.bonds.includes(bond))) continue;
    if (kind === 'chess' && prof && r.profession !== prof) continue;
    const name = typeof r.name === 'string' ? r.name : id;
    if (q) {
      const hay = [name, r.appellation, id].filter((x) => typeof x === 'string').join(' ').toLowerCase();
      if (!hay.includes(q)) continue;
    }
    out.push({
      id, goldenId: kind === 'chess' && typeof r.goldenId === 'string' ? r.goldenId : null, name, tier: num(r.tier, 0),
      special: kind === 'chess' && (r.visible === false || !!r.isHidden), golden: kind === 'item' && !!r.isGolden,
      order: num(r.shopSortId, 9999),
    });
  }
  out.sort((a, b) => a.tier - b.tier || Number(a.special) - Number(b.special) || Number(a.golden) - Number(b.golden)
    || a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return out.map(({ order, ...e }) => e);
}

/**
 * The room bar's lines for a debug room's settings — one per setting that differs from the official match, in a fixed
 * order; [] when everything is official.
 * @param {any} c a normalized config (room.state debugConfig)
 * @param {{ stage?: (id: string) => string, boss?: (id: string) => string, bond?: (id: string) => string,
 *   faction?: (type: string) => string, band?: (id: string) => string }} [names] display names
 * @returns {string[]}
 */
export function debugSummary(c, names = {}) {
  if (!isObj(c)) return [];
  const d = defaultDebugConfig();
  const name = (fn, id) => (typeof fn === 'function' && fn(id)) || id;
  const out = [];
  if (Number.isInteger(c.seed)) out.push(t('种子 {seed}', { seed: c.seed }));
  if (c.stageId) out.push(t('战场：{name}', { name: name(names.stage, c.stageId) }));
  if (c.bossId) out.push(t('最终攻势：{name}', { name: name(names.boss, c.bossId) }));
  if (c.hiddenBossId) out.push(t('隐秘核心：{name}', { name: name(names.boss, c.hiddenBossId) }));
  if (c.forceHidden) out.push(t('必定进入隐秘核心'));
  const bans = isObj(c.bans) ? c.bans : d.bans;
  if (bans.mode === 'none') out.push(t('不禁用盟约'));
  else if (bans.mode === 'custom') {
    const list = (Array.isArray(bans.bonds) ? bans.bonds : []).map((id) => name(names.bond, id));
    out.push(list.length ? t('禁用盟约：{names}', { names: list.join(tc('list', '、')) }) : t('不禁用盟约'));
  }
  if (Array.isArray(c.factions) && c.factions.length) out.push(t('特训敌人：{names}', { names: c.factions.map((x) => name(names.faction, x)).join(tc('list', '、')) }));
  const s = isObj(c.start) ? c.start : d.start;
  if (Number.isInteger(s.round) && s.round > 1) out.push(t('从第 {r} 回合开始', { r: s.round }));
  if (Number.isInteger(s.funds)) out.push(t('起始资金 {n}', { n: s.funds }));
  if (Number.isInteger(s.level)) out.push(t('调度中心 {n} 级', { n: s.level }));
  if (Number.isInteger(s.lp)) out.push(t('生命值 {n}', { n: s.lp }));
  if (s.lockLp) out.push(t('锁血'));
  const bands = isObj(c.bands) ? Object.keys(c.bands).filter((k) => typeof c.bands[k] === 'string').sort() : [];
  for (const k of bands) out.push(t('P{n} 策略：{name}', { n: Number(k) + 1, name: name(names.band, c.bands[k]) }));
  return out;
}

/** Display name of a 特训敌人 type: its factions.json `name` after the middle dot (「特训敌人·飞行」 → 飞行), else the type. */
export function factionTypeName(factions, type) {
  const rec = isObj(factions?.types) ? Object.values(factions.types).find((x) => isObj(x) && x.type === type) : null;
  const n = rec && typeof rec.name === 'string' ? rec.name : '';
  return n ? n.split(/[·・]/).pop().trim() || n : type;
}
