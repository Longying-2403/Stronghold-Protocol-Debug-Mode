// shared/debug.js — debug rooms (DESIGN §27): a remake tool for testing, the official game has none. Pure ESM, used by
// the server (server/lobby.js, server/match/match/debug.js) and by the browser (public/js/ui/debugRoom.js,
// public/js/ui/debugPanel.js), so both sides read the same lists and limits.
//
//   * debugOptions(tables, modeId) — what a debug room may choose in a mode, read from the game data the same way the
//     match reads it (server/match/gamedata.js): the battlefields in use, the Final Assault / Hidden Core leaders of the
//     mode, the bonds the match may disable, the 特训敌人 types, the strategies of the mode type, the rounds, the shop
//     levels.
//   * The pre-game settings (`room.debugConfig { config }`, host only, in the lobby): defaultDebugConfig() and
//     normalizeDebugConfig(raw, options) — LENIENT like room.ownership: an unknown id is dropped, a number is clamped,
//     a duplicate strategy of a co-op room keeps the lowest seat; the result is always complete. null means "as the
//     official match draws it" (seed, battlefield, leaders, enemy types) or "as the match gives it" (funds, level, LP).
//   * The in-match operations (`g.debug { op, target?, id?, value?, on?, mode? }`): DEBUG_OPS and checkDebugOp — the
//     fields each operation needs and their ranges; the match checks the rest (phase, rights, the target's state).

import { BOND_LAYER_CAP, MAX_SEATS } from './constants.js';

/** Battle speeds a debug room may set (game seconds per real second; the official speed is 2). */
export const DEBUG_SPEEDS = Object.freeze([1, 2, 4]);
/** The official battle speed (server/match/fields.js GAME_SPEED). */
export const DEBUG_DEFAULT_SPEED = 2;

/** Ranges of the debug settings and operations. */
export const DEBUG_LIMITS = Object.freeze({
  funds: 999, // 资金 (set: 0…999; add: −999…999)
  lp: 999, // 生命值 (1…999; 0 would eliminate — the debug tool never does that)
  layers: BOND_LAYER_CAP, // 盟约层数 (the official per-bond cap)
  grant: 3, // copies of one operator / item per 取用
  seed: 0xffffffff, // the match seed (uint32)
  round: 99, // a structural bound; the mode's boss round is the real one
  bans: 64, // ids in a custom ban list (there are 23 bonds)
  factions: 8, // ids in an enemy-type list (there are 6 types)
});

/** How the debug room picks the disabled bonds: the official draw, none at all, or the host's list. */
export const BAN_MODES = Object.freeze(['official', 'none', 'custom']);

/**
 * How `battle.end` ends the running battle phase: a normal round or 联防 — `natural` (fast-forward: the battle's own
 * result, at once), `leak` (now; the enemies on the field count as leaked, like a timeout) or `kill` (now; the enemies
 * left are not counted); the Final Assault / Hidden Core — `win` (the leader's pool is emptied) or `lose` (the team LP
 * is emptied).
 */
export const END_MODES = Object.freeze(['natural', 'leak', 'kill', 'win', 'lose']);

/**
 * The in-match operations: `target` — the player it applies to (the requester when absent; another player is the
 * host's right), `id` — a bond / chess / item id, `value` — its range [min, max] (`values`: the allowed values instead),
 * `on` — a switch, `mode` — END_MODES; `host` — only the room's host may use it; `prep` — in a 休整期 only;
 * `optional` — fields that may be absent. (`lp.set` works in a prep, and on the team LP during a leader battle.)
 */
export const DEBUG_OPS = Object.freeze({
  'funds.set': { target: true, value: [0, DEBUG_LIMITS.funds], prep: true },
  'funds.add': { target: true, value: [-DEBUG_LIMITS.funds, DEBUG_LIMITS.funds], prep: true },
  'level.set': { target: true, value: [1, 9], prep: true },
  'level.up': { target: true, prep: true },
  'lp.set': { target: true, value: [1, DEBUG_LIMITS.lp] },
  'lp.lock': { on: true, host: true },
  'layers.set': { target: true, id: true, value: [0, DEBUG_LIMITS.layers], prep: true },
  'layers.add': { target: true, id: true, value: [1, DEBUG_LIMITS.layers], prep: true },
  'chess.grant': { target: true, id: true, value: [1, DEBUG_LIMITS.grant], optional: ['value'], prep: true },
  'item.grant': { target: true, id: true, value: [1, DEBUG_LIMITS.grant], optional: ['value'], prep: true },
  'speed.set': { values: DEBUG_SPEEDS, host: true },
  'prep.freeze': { on: true, host: true },
  'battle.end': { mode: true, host: true },
  'round.jump': { value: [1, DEBUG_LIMITS.round], host: true, prep: true },
});

const isInt = (v, lo = -Infinity, hi = Infinity) => Number.isInteger(v) && v >= lo && v <= hi;
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64 && /^[A-Za-z0-9_\-.:]+$/.test(v);
const isBool = (v) => typeof v === 'boolean';
const nullable = (check) => (v) => v === null || v === undefined || check(v);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const posInt = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);

/** Whether `v` names an in-match operation (the protocol's `g.debug.op`). */
export const isDebugOp = (v) => typeof v === 'string' && Object.hasOwn(DEBUG_OPS, v);

/** The settings of a new debug room: everything as the official match does it. */
export function defaultDebugConfig() {
  return {
    seed: null,
    stageId: null,
    bossId: null,
    hiddenBossId: null,
    forceHidden: false,
    bans: { mode: 'official', bonds: [] },
    factions: null,
    start: { round: 1, funds: null, level: null, lp: null, lockLp: false },
    bands: {},
  };
}

/**
 * Structural check of `room.debugConfig.config` (types and sizes only; normalizeDebugConfig settles the values against
 * the game data). Every key is optional: an absent one takes its default.
 */
export function isDebugConfigWire(v) {
  if (!isPlain(v)) return false;
  const ids = (x, max) => Array.isArray(x) && x.length <= max && x.every(isId);
  if (!nullable((x) => isInt(x, 0, DEBUG_LIMITS.seed))(v.seed)) return false;
  for (const k of ['stageId', 'bossId', 'hiddenBossId']) if (!nullable(isId)(v[k])) return false;
  if (!nullable(isBool)(v.forceHidden)) return false;
  if (v.bans != null && !(isPlain(v.bans) && nullable((x) => BAN_MODES.includes(x))(v.bans.mode) && nullable((x) => ids(x, DEBUG_LIMITS.bans))(v.bans.bonds))) return false;
  if (!nullable((x) => ids(x, DEBUG_LIMITS.factions))(v.factions)) return false;
  if (v.start != null) {
    const s = v.start;
    if (!isPlain(s)) return false;
    if (!nullable((x) => isInt(x, 1, DEBUG_LIMITS.round))(s.round)) return false;
    if (!nullable((x) => isInt(x, 0, DEBUG_LIMITS.funds))(s.funds)) return false;
    if (!nullable((x) => isInt(x, 1, 9))(s.level)) return false;
    if (!nullable((x) => isInt(x, 1, DEBUG_LIMITS.lp))(s.lp)) return false;
    if (!nullable(isBool)(s.lockLp)) return false;
  }
  if (v.bands != null) {
    if (!isPlain(v.bands)) return false;
    const keys = Object.keys(v.bands);
    if (keys.length > MAX_SEATS) return false;
    for (const k of keys) if (!/^[0-9]$/.test(k) || Number(k) >= MAX_SEATS || !nullable(isId)(v.bands[k])) return false;
  }
  return true;
}

/**
 * What a debug room may choose in a mode — the same reading of the data as the match (server/match/gamedata.js,
 * waves.js setupMatchWaves, pool.js drawDisabledBonds):
 *   stages        the battlefields in use (active, weight > 0 — the 8 of 险境; the upper-half 战场#05–#07 and the 联防
 *                 positions are not), in id order
 *   bosses        the Final Assault leaders of the mode (bossWeights > 0), hiddenBosses the Hidden Core's (none without a
 *                 hidden round)
 *   bonds         the bonds the match may disable (weight > 0, not switched off by the mode), in bond order;
 *                 staticOffBonds the mode's own inactive bonds (always off, the 标准 list)
 *   factionTypes  the 特训敌人 types a match draws from (involveRandom), maxFactions how many it draws (3)
 *   bands         the strategies of the mode type (SINGLE / MULTI), in sortId order
 *   lastRound, bossRound, hiddenRound, maxLevel, isSolo
 * @param {{ config?: any, stages?: any, bosses?: any, bonds?: any, factions?: any, bands?: any }} tables the data files
 * @param {string} modeId e.g. 'mode_multi_hard'
 */
export function debugOptions(tables, modeId) {
  const t = tables && typeof tables === 'object' ? tables : {};
  const modes = t.config && typeof t.config.modes === 'object' && t.config.modes ? t.config.modes : {};
  const mode = Object.hasOwn(modes, modeId) && modes[modeId] && typeof modes[modeId] === 'object' ? modes[modeId] : {};
  const own = (map, id) => (map && typeof map === 'object' && Object.hasOwn(map, id) && map[id] && typeof map[id] === 'object' ? map[id] : null);
  const isSolo = mode.type === 'SINGLE' || /^mode_single_/.test(String(modeId || ''));
  const lastRound = posInt(mode.lastRound, modeId === 'mode_single_funny' ? 9 : 14);
  const bossRound = posInt(mode.bossRound, lastRound);
  const hiddenRound = posInt(mode.hiddenRound, null);
  const maxLevel = posInt(mode.maxShopLevel, 6);
  const stages = Object.keys(t.stages && typeof t.stages === 'object' ? t.stages : {})
    .filter((id) => { const s = own(t.stages, id); return s && s.active !== false && num(Number(s.weight), 0) > 0; }).sort();
  const weighted = (w) => (w && typeof w === 'object' ? Object.entries(w).filter(([id, v]) => own(t.bosses, id) && Number(v) > 0).map(([id]) => id) : []);
  const bosses = weighted(mode.bossWeights);
  const hiddenBosses = hiddenRound ? weighted(mode.hiddenBossWeights) : [];
  const inactive = new Set(Array.isArray(mode.inactiveBondIds) ? mode.inactiveBondIds : []);
  const bondIds = Object.keys(t.bonds && typeof t.bonds === 'object' ? t.bonds : {}).filter((id) => own(t.bonds, id))
    .sort((a, b) => (num(t.bonds[a].identifier, 99) - num(t.bonds[b].identifier, 99)) || (a < b ? -1 : 1));
  const bonds = bondIds.filter((id) => Number(t.bonds[id].weight) > 0 && !inactive.has(id));
  const staticOffBonds = bondIds.filter((id) => inactive.has(id));
  const types = t.factions && typeof t.factions.types === 'object' && t.factions.types ? Object.values(t.factions.types) : [];
  const factionTypes = types.filter((x) => x && x.involveRandom && typeof x.type === 'string')
    .sort((a, b) => num(a.sortId, 9) - num(b.sortId, 9) || (a.type < b.type ? -1 : 1)).map((x) => x.type);
  const maxFactions = posInt(t.factions?.generation?.specialEnemyNum, 3);
  const bands = Object.keys(t.bands && typeof t.bands === 'object' ? t.bands : {}).filter((id) => {
    const b = own(t.bands, id);
    const list = b && Array.isArray(b.modeTypeList) ? b.modeTypeList : null;
    return !!b && (!list || list.includes(isSolo ? 'SINGLE' : 'MULTI'));
  }).sort((a, b) => num(t.bands[a].sortId, 99) - num(t.bands[b].sortId, 99) || (a < b ? -1 : 1));
  return { modeId, isSolo, stages, bosses, hiddenBosses, bonds, staticOffBonds, factionTypes, maxFactions, bands, lastRound, bossRound, hiddenRound, maxLevel };
}

const clampInt = (v, lo, hi, d) => (Number.isInteger(v) ? Math.max(lo, Math.min(hi, v)) : d);

/**
 * The debug settings checked against what the mode offers (debugOptions): lenient — an unknown id is dropped, a number
 * is clamped into its range, a strategy is kept once (co-op rooms: the lowest seat keeps it, 队友已选), settings the mode
 * has no use for are cleared (a Hidden Core leader / forced Hidden Core without a hidden round). Always complete.
 * @param {any} raw `room.debugConfig.config` (or a stored config)
 * @param {ReturnType<typeof debugOptions>} opt
 * @returns {ReturnType<typeof defaultDebugConfig>}
 */
export function normalizeDebugConfig(raw, opt) {
  const r = isPlain(raw) ? raw : {};
  const out = defaultDebugConfig();
  if (isInt(r.seed, 0, DEBUG_LIMITS.seed)) out.seed = r.seed;
  if (opt.stages.includes(r.stageId)) out.stageId = r.stageId;
  if (opt.bosses.includes(r.bossId)) out.bossId = r.bossId;
  if (opt.hiddenRound && opt.hiddenBosses.includes(r.hiddenBossId)) out.hiddenBossId = r.hiddenBossId;
  out.forceHidden = !!opt.hiddenRound && r.forceHidden === true;
  const b = isPlain(r.bans) ? r.bans : {};
  out.bans.mode = BAN_MODES.includes(b.mode) ? b.mode : 'official';
  if (out.bans.mode === 'custom') {
    const want = new Set(Array.isArray(b.bonds) ? b.bonds : []);
    out.bans.bonds = opt.bonds.filter((id) => want.has(id));
  }
  if (Array.isArray(r.factions)) {
    const want = new Set(r.factions);
    const keep = opt.factionTypes.filter((x) => want.has(x)).slice(0, opt.maxFactions);
    out.factions = keep.length ? keep : null;
  }
  const s = isPlain(r.start) ? r.start : {};
  out.start.round = clampInt(s.round, 1, opt.bossRound, 1);
  out.start.funds = Number.isInteger(s.funds) ? clampInt(s.funds, 0, DEBUG_LIMITS.funds, null) : null;
  out.start.level = Number.isInteger(s.level) ? clampInt(s.level, 1, opt.maxLevel, null) : null;
  out.start.lp = Number.isInteger(s.lp) ? clampInt(s.lp, 1, DEBUG_LIMITS.lp, null) : null;
  out.start.lockLp = s.lockLp === true;
  const bands = isPlain(r.bands) ? r.bands : {};
  const used = new Set();
  for (let i = 0; i < (opt.isSolo ? 1 : MAX_SEATS); i++) {
    const id = Object.hasOwn(bands, String(i)) ? bands[String(i)] : null;
    if (typeof id !== 'string' || !opt.bands.includes(id) || used.has(id)) continue;
    out.bands[String(i)] = id;
    used.add(id);
  }
  return out;
}

/** Whether a normalized config leaves everything as the official match does it (defaultDebugConfig). */
export function isOfficialConfig(c) {
  return !!c && JSON.stringify(c) === JSON.stringify(defaultDebugConfig());
}

/**
 * @typedef {{ ok: true, op: string, target: string|null, id: string|null, value: number|null, on: boolean|null, mode: string|null }} DebugOpOk
 * @typedef {{ error: 'BAD_MSG', detail: string }} DebugOpBad
 */

/**
 * Shape check of a `g.debug` message against DEBUG_OPS: the fields its operation needs, in range. The match checks the
 * rest (the phase, the rights, the target, the ids against the data).
 * @param {any} msg
 * @returns {DebugOpOk | DebugOpBad}
 */
export function checkDebugOp(msg) {
  /** @param {string} detail @returns {DebugOpBad} */
  const bad = (detail) => ({ error: 'BAD_MSG', detail });
  if (!msg || typeof msg !== 'object' || !isDebugOp(msg.op)) return bad('unknown debug operation');
  const spec = DEBUG_OPS[msg.op];
  const optional = spec.optional || [];
  /** @type {DebugOpOk} */
  const out = { ok: true, op: msg.op, target: null, id: null, value: null, on: null, mode: null };
  if (msg.target != null) {
    if (!spec.target || !isId(msg.target)) return bad('target');
    out.target = msg.target;
  }
  if (spec.id) {
    if (!isId(msg.id)) return bad('id');
    out.id = msg.id;
  }
  if (spec.value || spec.values) {
    if (msg.value == null && optional.includes('value')) out.value = null;
    else {
      const ok = spec.values ? spec.values.includes(msg.value) : isInt(msg.value, spec.value[0], spec.value[1]);
      if (!ok) return bad('value');
      out.value = msg.value;
    }
  }
  if (spec.on) {
    if (!isBool(msg.on)) return bad('on');
    out.on = msg.on;
  }
  if (spec.mode) {
    if (!END_MODES.includes(msg.mode)) return bad('mode');
    out.mode = msg.mode;
  }
  return out;
}
