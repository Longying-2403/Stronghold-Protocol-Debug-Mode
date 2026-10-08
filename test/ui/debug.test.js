// Debug rooms in the browser (DESIGN §27), Node side: the pure logic of the panel and the room bar
// (public/js/ui/gameLogic/debug.js — which operations a viewer may use now and why not, the targets, the battle-end
// choices of a phase, the 取用 catalog, the summary of a room's settings, the 特训敌人 type names) and the way in
// (public/js/ui/debugMode.js — the DBUG key, the two switches, the confirmation before create / join / spectate).
// In a browser: test/ui/debug.e2e.test.js; server side: test/lobby-debug.test.js, test/match/debug.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PHASE, ERR } from '../../shared/constants.js';
import { defaultDebugConfig } from '../../shared/debug.js';
import { debugEndModes, debugOpState, debugWhyText, debugTargets, debugCatalog, debugSummary, factionTypeName } from '../../public/js/ui/gameLogic.js';
import { isDebugCode, serverDebugRooms, enterDebugRoom, joinWithAck, setDebugEnabled, debugPrefStore } from '../../public/js/ui/debugMode.js';
import { parseIntField } from '../../public/js/ui/debugRoom.js';
import { store } from '../../public/js/store.js';

test('battle-end choices by phase: natural / leak / kill in a battle or 联防, win / lose against a leader, none elsewhere', () => {
  assert.deepEqual(debugEndModes(PHASE.COMBAT), ['natural', 'leak', 'kill']);
  assert.deepEqual(debugEndModes(PHASE.UNITE), ['natural', 'leak', 'kill']);
  assert.deepEqual(debugEndModes(PHASE.FINAL_ASSAULT), ['win', 'lose']);
  assert.deepEqual(debugEndModes(PHASE.HIDDEN_CORE), ['win', 'lose']);
  for (const ph of [PHASE.PREP, PHASE.SP_DRAFT, PHASE.SETTLE, PHASE.RESULT, null]) assert.deepEqual(debugEndModes(ph), [], String(ph));
});

test('debugOpState: the host\'s operations, another player\'s state, an eliminated target, prep-only operations, the team LP', () => {
  const st = (op, ctx) => debugOpState(op, ctx);
  const prep = { phase: PHASE.PREP, isHost: false, self: true };
  assert.deepEqual(st('funds.set', prep), { ok: true, why: null }, 'one\'s own funds in a prep');
  assert.deepEqual(st('funds.set', { ...prep, self: false }), { ok: false, why: 'host' }, 'another player: the host only');
  assert.deepEqual(st('funds.set', { ...prep, self: false, isHost: true }), { ok: true, why: null });
  assert.deepEqual(st('funds.set', { ...prep, alive: false }), { ok: false, why: 'dead' });
  assert.deepEqual(st('funds.set', { ...prep, phase: PHASE.COMBAT }), { ok: false, why: 'prep' });
  for (const op of ['speed.set', 'prep.freeze', 'lp.lock', 'battle.end', 'round.jump']) {
    assert.equal(st(op, { ...prep, phase: PHASE.COMBAT }).why, 'host', op);
  }
  assert.deepEqual(st('speed.set', { phase: PHASE.COMBAT, isHost: true }), { ok: true, why: null });
  assert.deepEqual(st('battle.end', { phase: PHASE.PREP, isHost: true }), { ok: false, why: 'battle' });
  assert.deepEqual(st('battle.end', { phase: PHASE.UNITE, isHost: true }), { ok: true, why: null });
  assert.deepEqual(st('round.jump', { phase: PHASE.COMBAT, isHost: true }), { ok: false, why: 'prep' });
  assert.deepEqual(st('lp.set', { phase: PHASE.FINAL_ASSAULT, teamLp: true }), { ok: true, why: null }, 'the team LP in a leader battle');
  assert.deepEqual(st('lp.set', { phase: PHASE.COMBAT, teamLp: false }), { ok: false, why: 'prep' });
  assert.deepEqual(st('nope', prep), { ok: false, why: 'unknown' });
  assert.equal(debugWhyText('host'), '只有房主可以操作');
  assert.equal(debugWhyText('dead'), '该博士已被淘汰');
  assert.equal(debugWhyText('prep'), '休整期中才能使用');
  assert.equal(debugWhyText('battle'), '作战中才能使用');
  assert.equal(debugWhyText(null), '');
});

test('debugTargets: the viewer alone, or (the host) every player still in, AI seats included, in seat order', () => {
  const pub = { players: [
    { playerId: 'p2', name: 'B', seat: 2, alive: true },
    { playerId: 'ai_0', name: 'AI', seat: 1, isBot: true, alive: true },
    { playerId: 'p1', name: 'A', seat: 0, alive: true },
    { playerId: 'p3', name: 'C', seat: 3, alive: false },
    { playerId: 'p4', name: 'D', seat: 4, status: 'left' },
  ] };
  assert.deepEqual(debugTargets(pub, 'p2', false).map((p) => [p.playerId, p.self]), [['p2', true]]);
  assert.deepEqual(debugTargets(pub, 'p1', true).map((p) => [p.playerId, p.self, p.isBot, p.alive]),
    [['p1', true, false, true], ['ai_0', false, true, true], ['p2', false, false, true], ['p3', false, false, false]]);
  assert.deepEqual(debugTargets(null, 'p1', true), []);
});

test('debugCatalog: base operators (elite = goldenId), filters by tier / class / bond / name, the shop order; items with their elite versions', () => {
  const recs = [
    { chessId: 'c2', name: '乙', tier: 2, profession: 'SNIPER', bonds: ['b1'], goldenId: 'c2g', shopSortId: 1 },
    { chessId: 'c1', name: '甲', appellation: 'Alpha', tier: 1, profession: 'WARRIOR', bonds: ['b1', 'b2'], goldenId: 'c1g', shopSortId: 5 },
    { chessId: 'c1g', name: '甲', tier: 1, isGolden: true },
    { chessId: 'c3', name: '丙', tier: 1, profession: 'WARRIOR', bonds: ['b2'], visible: false, shopSortId: 0 },
    { chessId: 'diy_1', name: '甄选干员', tier: 5, isDiy: true },
    { chessId: 'c4', name: '丁', tier: 1, profession: 'MEDIC', bonds: [], shopSortId: 2 },
  ];
  const ids = (f) => debugCatalog(recs, f).map((e) => e.id);
  assert.deepEqual(ids({ kind: 'chess' }), ['c4', 'c1', 'c3', 'c2'], 'by tier, the shop order, the ones the shop never offers last');
  assert.deepEqual(debugCatalog(recs, { kind: 'chess', query: 'alpha' }), [{ id: 'c1', goldenId: 'c1g', name: '甲', tier: 1, special: false, golden: false }]);
  assert.deepEqual(ids({ kind: 'chess', tier: 2 }), ['c2']);
  assert.deepEqual(ids({ kind: 'chess', prof: 'WARRIOR' }), ['c1', 'c3']);
  assert.deepEqual(ids({ kind: 'chess', bond: 'b2' }), ['c1', 'c3']);
  assert.deepEqual(ids({ kind: 'chess', query: 'c2' }), ['c2'], 'by id too');
  assert.equal(debugCatalog(recs, { kind: 'chess' }).find((e) => e.id === 'c3').special, true);
  const items = [{ id: 'i1_b', name: '锤', tier: 1, isGolden: true, shopSortId: 1 }, { id: 'i1_a', name: '锤', tier: 1, shopSortId: 1 }, { id: 'i0', name: '盾', tier: 3 }];
  assert.deepEqual(debugCatalog(items, { kind: 'item' }).map((e) => [e.id, e.golden]), [['i1_a', false], ['i1_b', true], ['i0', false]]);
  assert.deepEqual(debugCatalog(null, { kind: 'item' }), []);
});

test('debugSummary: one line per setting that differs from the official match, with display names; none for the default', () => {
  assert.deepEqual(debugSummary(defaultDebugConfig()), []);
  assert.deepEqual(debugSummary(null), []);
  const names = { stage: (id) => `S:${id}`, boss: (id) => `B:${id}`, bond: (id) => `N:${id}`, faction: (t) => `F:${t}`, band: (id) => `D:${id}` };
  const c = { ...defaultDebugConfig(), seed: 42, stageId: 'st', bossId: 'b1', hiddenBossId: 'b9', forceHidden: true,
    bans: { mode: 'custom', bonds: ['x', 'y'] }, factions: ['FLY', 'DOT'], start: { round: 3, funds: 20, level: 4, lp: 9, lockLp: true }, bands: { 1: 'band_a' } };
  assert.deepEqual(debugSummary(c, names), [
    '种子 42', '战场：S:st', '最终攻势：B:b1', '隐秘核心：B:b9', '必定进入隐秘核心', '禁用盟约：N:x、N:y', '特训敌人：F:FLY、F:DOT',
    '从第 3 回合开始', '起始资金 20', '调度中心 4 级', '生命值 9', '锁血', 'P2 策略：D:band_a',
  ]);
  assert.deepEqual(debugSummary({ ...defaultDebugConfig(), bans: { mode: 'none', bonds: [] } }), ['不禁用盟约']);
  assert.deepEqual(debugSummary({ ...defaultDebugConfig(), bans: { mode: 'custom', bonds: [] } }), ['不禁用盟约']);
});

test('factionTypeName: the 特训敌人 record\'s name after the middle dot, else the type; parseIntField', () => {
  const factions = { types: { a: { type: 'FLY', name: '特训敌人·飞行' }, b: { type: 'DOT', name: 'DOT' } } };
  assert.equal(factionTypeName(factions, 'FLY'), '飞行');
  assert.equal(factionTypeName(factions, 'DOT'), 'DOT');
  assert.equal(factionTypeName(factions, 'TIMES'), 'TIMES');
  assert.equal(factionTypeName(null, 'FLY'), 'FLY');
  assert.equal(parseIntField('', 0, 9), null);
  assert.equal(parseIntField(' 12 ', 0, 9), 9);
  assert.equal(parseIntField('-4', 1, 9), 1);
  assert.equal(parseIntField('3.7', 0, 9), 3);
  assert.equal(parseIntField('x', 0, 9), null);
});

test('the way in: DBUG, the server and the client switches, the confirmation before a debug room is created or entered', async () => {
  assert.equal(isDebugCode('DBUG'), true);
  assert.equal(isDebugCode(' dbug '), true);
  assert.equal(isDebugCode('DBUX'), false);
  assert.equal(isDebugCode(null), false);
  const calls = [];
  const request = async (t, f) => { calls.push([t, f]); };
  const yes = async () => true;
  const no = async () => false;
  // the server says no (welcome.debugRooms false): nothing is sent
  store.patch('ui', { debugRooms: false });
  assert.equal(serverDebugRooms(), false);
  assert.equal(await enterDebugRoom({ mode: 'coop', difficulty: 'HARD', request, confirm: yes }), false);
  store.patch('ui', { debugRooms: true });
  // the switch is off by default: nothing is sent
  assert.equal(debugPrefStore.get().enabled, false);
  assert.equal(await enterDebugRoom({ mode: 'coop', difficulty: 'HARD', request, confirm: yes }), false);
  assert.deepEqual(calls, []);
  setDebugEnabled(true);
  assert.equal(await enterDebugRoom({ mode: 'coop', difficulty: 'HARD', request, confirm: no }), false, 'declined');
  assert.deepEqual(calls, []);
  assert.equal(await enterDebugRoom({ mode: 'solo', difficulty: 'FUNNY', request, confirm: yes }), true);
  assert.deepEqual(calls, [['room.create', { mode: 'solo', difficulty: 'FUNNY', debug: true }]]);
  setDebugEnabled(false);
  // joining a key: an ordinary room needs nothing; a debug room asks, then goes again with debugAck
  calls.length = 0;
  assert.equal(await joinWithAck('room.join', 'ABCD', request, () => assert.fail('no question for an ordinary room')), true);
  assert.deepEqual(calls, [['room.join', { code: 'ABCD' }]]);
  const debugRoom = async (t, f) => { calls.push([t, f]); if (!f.debugAck) throw Object.assign(new Error('confirm'), { code: ERR.DEBUG_CONFIRM }); };
  calls.length = 0;
  assert.equal(await joinWithAck('room.spectate', 'WXYZ', debugRoom, yes), true);
  assert.deepEqual(calls, [['room.spectate', { code: 'WXYZ' }], ['room.spectate', { code: 'WXYZ', debugAck: true }]]);
  calls.length = 0;
  assert.equal(await joinWithAck('room.join', 'WXYZ', debugRoom, no), false, 'declined: not entered');
  assert.deepEqual(calls, [['room.join', { code: 'WXYZ' }]]);
  await assert.rejects(joinWithAck('room.join', 'QQQQ', async () => { throw Object.assign(new Error('nope'), { code: ERR.ROOM_NOT_FOUND }); }, yes),
    (e) => e.code === ERR.ROOM_NOT_FOUND, 'any other refusal goes to the caller');
});
