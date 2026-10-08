// shared/debug.js (DESIGN §27): what a debug room may choose in a mode (debugOptions over the real data), the lenient
// check of its pre-game settings (normalizeDebugConfig) and their wire shape, and the shape check of the in-match
// operations (DEBUG_OPS / checkDebugOp).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modeIdFor, MAX_SEATS } from '../shared/constants.js';
import {
  DEBUG_SPEEDS, DEBUG_DEFAULT_SPEED, DEBUG_LIMITS, BAN_MODES, END_MODES, DEBUG_OPS, isDebugOp, defaultDebugConfig,
  isDebugConfigWire, debugOptions, normalizeDebugConfig, isOfficialConfig, checkDebugOp,
} from '../shared/debug.js';
import { getData } from '../server/data.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const opts = (mode, difficulty) => debugOptions(DATA, modeIdFor(mode, difficulty));

test('the lists: speeds 1 / 2 / 4 (2 official), ban modes, end modes, every operation names its fields', () => {
  assert.deepEqual(DEBUG_SPEEDS, [1, 2, 4]);
  assert.equal(DEBUG_DEFAULT_SPEED, 2);
  assert.deepEqual(BAN_MODES, ['official', 'none', 'custom']);
  assert.deepEqual(END_MODES, ['natural', 'leak', 'kill', 'win', 'lose']);
  assert.equal(DEBUG_LIMITS.funds, 999);
  for (const [op, spec] of Object.entries(DEBUG_OPS)) {
    assert.ok(isDebugOp(op));
    assert.ok(Object.isFrozen(DEBUG_OPS));
    for (const k of Object.keys(spec)) assert.ok(['target', 'id', 'value', 'values', 'on', 'mode', 'prep', 'host', 'optional'].includes(k), `${op}.${k}`);
  }
  assert.equal(isDebugOp('constructor'), false);
  assert.equal(isDebugOp('toString'), false);
  assert.equal(isDebugOp(42), false);
});

test('debugOptions: the battlefields in use, the leaders, the bonds a match may disable, the enemy types and strategies of a mode', () => {
  const funny = opts('coop', 'FUNNY');
  const normal = opts('coop', 'NORMAL');
  const solo = opts('solo', 'FUNNY');
  assert.equal(funny.stages.length, 8, 'the 8 battlefields in use');
  assert.ok(funny.stages.every((id) => DATA.stages[id] && Number(DATA.stages[id].weight) > 0));
  assert.deepEqual(funny.hiddenBosses, [], '标准 has no Hidden Core');
  assert.equal(funny.hiddenRound, null);
  assert.ok(normal.hiddenBosses.length > 0 && normal.hiddenRound === 15);
  assert.ok(funny.staticOffBonds.length > 0, '标准 switches some bonds off');
  for (const b of funny.staticOffBonds) assert.ok(!funny.bonds.includes(b), `${b} is never a choice`);
  assert.equal(funny.factionTypes.length, 6);
  assert.equal(funny.maxFactions, 3);
  assert.deepEqual([solo.isSolo, solo.lastRound, solo.bossRound], [true, 9, 9], '独立标准: 9 rounds');
  assert.deepEqual([funny.isSolo, funny.bossRound, funny.maxLevel], [false, 14, 6]);
  for (const id of funny.bands) assert.ok(!DATA.bands[id].modeTypeList || DATA.bands[id].modeTypeList.includes('MULTI'), id);
  for (const id of solo.bands) assert.ok(!DATA.bands[id].modeTypeList || DATA.bands[id].modeTypeList.includes('SINGLE'), id);
  // bad input never throws
  assert.deepEqual(debugOptions(null, 'mode_x').stages, []);
  assert.equal(debugOptions({}, 'mode_single_funny').lastRound, 9);
});

test('normalizeDebugConfig: lenient — unknown ids dropped, numbers clamped, a strategy kept once, settings without a use cleared', () => {
  const normal = opts('coop', 'NORMAL');
  assert.deepEqual(normalizeDebugConfig({}, normal), defaultDebugConfig());
  assert.deepEqual(normalizeDebugConfig(null, normal), defaultDebugConfig());
  assert.ok(isOfficialConfig(normalizeDebugConfig('junk', normal)));
  const c = normalizeDebugConfig({
    seed: 1234, stageId: 'act1autochess_m03', bossId: 'boss_x', hiddenBossId: 'boss_9', forceHidden: true,
    bans: { mode: 'custom', bonds: ['yanShip', 'nope', 'yanShip', normal.bonds[1]] }, factions: ['DOT', 'FLY', 'NOPE', 'TIMES', 'ELEMENT'],
    start: { round: 99, funds: 5000, level: 0, lp: -3, lockLp: 'yes' },
    bands: { 0: 'band_amiya', 1: 'band_amiya', 2: 'band_nope', 3: 'band_bldsk', 7: 'band_duyaoy' },
  }, normal);
  assert.equal(c.seed, 1234);
  assert.equal(c.stageId, 'act1autochess_m03');
  assert.equal(c.bossId, null, 'an unknown leader is dropped');
  assert.equal(c.hiddenBossId, 'boss_9');
  assert.equal(c.forceHidden, true);
  assert.deepEqual(c.bans, { mode: 'custom', bonds: normal.bonds.filter((b) => b === 'yanShip' || b === normal.bonds[1]) });
  assert.deepEqual(c.factions, ['FLY', 'TIMES', 'ELEMENT'], 'the first three known types, in the data order');
  assert.deepEqual(c.start, { round: 14, funds: 999, level: 1, lp: 1, lockLp: false });
  assert.deepEqual(c.bands, { 0: 'band_amiya', 3: 'band_bldsk' }, 'a strategy once (the lowest seat), seats 0–3 only');
  // a mode without a Hidden Core clears its settings; a solo room keeps seat 0 only
  const funny = normalizeDebugConfig({ hiddenBossId: 'boss_9', forceHidden: true, start: { round: 12, level: 9 }, bands: { 0: 'band_amiya', 1: 'band_bldsk' } }, opts('solo', 'FUNNY'));
  assert.deepEqual([funny.hiddenBossId, funny.forceHidden, funny.start.round, funny.start.level], [null, false, 9, 6]);
  assert.deepEqual(funny.bands, { 0: 'band_amiya' });
  assert.deepEqual(normalizeDebugConfig({ bans: { mode: 'weird', bonds: ['yanShip'] } }, normal).bans, { mode: 'official', bonds: [] });
  assert.deepEqual(normalizeDebugConfig({ bans: { mode: 'none', bonds: ['yanShip'] } }, normal).bans, { mode: 'none', bonds: [] });
  assert.equal(normalizeDebugConfig({ factions: ['NOPE'] }, normal).factions, null, 'nothing known: the official draw');
  assert.equal(normalizeDebugConfig({ seed: 2 ** 32 }, normal).seed, null);
  assert.equal(isOfficialConfig(c), false);
  assert.equal(MAX_SEATS, 4);
});

test('isDebugConfigWire: types and sizes only (every key optional)', () => {
  assert.equal(isDebugConfigWire({}), true);
  assert.equal(isDebugConfigWire(defaultDebugConfig()), true);
  assert.equal(isDebugConfigWire({ seed: 7, stageId: 'a', bans: { mode: 'custom', bonds: ['x'] }, factions: ['FLY'], start: { round: 3, funds: 0, level: 6, lp: 999, lockLp: true }, bands: { 0: 'band_x', 3: null } }), true);
  for (const bad of [null, [], 'x', { seed: -1 }, { seed: 1.5 }, { stageId: 'bad id' }, { forceHidden: 1 }, { bans: { mode: 'all' } },
    { bans: { bonds: Array(65).fill('x') } }, { factions: Array(9).fill('FLY') }, { start: { round: 0 } }, { start: { funds: 1000 } },
    { start: { level: 10 } }, { start: { lp: 0 } }, { start: { lockLp: 'no' } }, { start: [] }, { bands: { 4: 'band_x' } }, { bands: { a: 'band_x' } },
    { bands: { 0: 5 } }]) {
    assert.equal(isDebugConfigWire(bad), false, JSON.stringify(bad));
  }
});

test('checkDebugOp: the fields an operation needs, in range; anything else is BAD_MSG', () => {
  assert.deepEqual(checkDebugOp({ op: 'funds.set', value: 10 }), { ok: true, op: 'funds.set', target: null, id: null, value: 10, on: null, mode: null });
  assert.deepEqual(checkDebugOp({ op: 'chess.grant', id: 'chess_char_1_01_a', target: 'p_1' }), { ok: true, op: 'chess.grant', target: 'p_1', id: 'chess_char_1_01_a', value: null, on: null, mode: null });
  assert.equal(checkDebugOp({ op: 'chess.grant', id: 'c', value: 3 }).value, 3);
  assert.equal(checkDebugOp({ op: 'speed.set', value: 4 }).value, 4);
  assert.equal(checkDebugOp({ op: 'level.up' }).ok, true);
  const bad = (msg, detail) => assert.deepEqual(checkDebugOp(msg), { error: 'BAD_MSG', detail }, JSON.stringify(msg));
  bad(null, 'unknown debug operation');
  bad({ op: '__proto__' }, 'unknown debug operation');
  bad({ op: 'speed.set', value: 3 }, 'value');
  bad({ op: 'funds.set' }, 'value');
  bad({ op: 'funds.add', value: 1000 }, 'value');
  bad({ op: 'chess.grant', id: 'c', value: 4 }, 'value');
  bad({ op: 'layers.add', id: 'yanShip', value: 0 }, 'value');
  bad({ op: 'layers.set', value: 1 }, 'id');
  bad({ op: 'lp.lock' }, 'on');
  bad({ op: 'battle.end', mode: 'boom' }, 'mode');
  bad({ op: 'speed.set', value: 2, target: 'p_1' }, 'target');
});
