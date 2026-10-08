// Debug rooms in the match (DESIGN §27, server/match/match/debug.js): the setup overrides and the start state of a
// debug room's settings, every g.debug operation with its rights and phases, the battle speed (clocks rebased, never a
// jump), the host's pause of a co-op battle, the frozen prep countdown, ending a battle (natural / leak / kill, win /
// lose), jumping to a round, the LP lock and forceHidden — and that an ordinary match is untouched (the same draws for
// the same seed, g.debug refused). A fuzz of a debug room keeps the match invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERR, PHASE, modeIdFor } from '../../shared/constants.js';
import { DEBUG_OPS, END_MODES, debugOptions } from '../../shared/debug.js';
import { validateC2S, C2S } from '../../shared/protocol.js';
import { createRng } from '../../server/sim/rng.js';
import { DATA, makeMatch, checkInvariants } from './harness.js';

const HOST = 'p_0';
const dbg = (m, pid, fields) => m.handle(pid, { t: 'g.debug', ...fields });
/** A co-op debug match: 2 humans (p_0 hosts) and an AI seat. */
const debugMatch = (o = {}) => makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 1, seed: 11, fake: true, hostId: () => HOST, ...o, debug: o.debug ?? {} });
const setupOf = (m) => ({
  stageId: m.stageId, factions: [...m.factions], schedule: m.factions.schedule, bossId: m.bossId, hiddenBossId: m.hiddenBossId,
  disabledBonds: m.disabledBonds, staticInactiveBonds: m.staticInactiveBonds, bannedChess: m.bannedChess,
});
const options = (mode, difficulty) => debugOptions(DATA, modeIdFor(mode, difficulty));

test('protocol: g.debug carries an operation of DEBUG_OPS and its fields; the match checks the rest', () => {
  assert.ok(C2S['g.debug']);
  assert.equal(validateC2S({ t: 'g.debug', op: 'funds.set', value: 10 }), null);
  assert.equal(validateC2S({ t: 'g.debug', op: 'battle.end', mode: 'kill' }), null);
  assert.equal(validateC2S({ t: 'g.debug', op: 'chess.grant', id: 'chess_char_1_01_a', target: 'p_1' }), null);
  assert.notEqual(validateC2S({ t: 'g.debug' }), null, 'an operation is required');
  assert.notEqual(validateC2S({ t: 'g.debug', op: 'funds.steal', value: 1 }), null, 'unknown operation');
  assert.notEqual(validateC2S({ t: 'g.debug', op: 'battle.end', mode: 'explode' }), null);
  assert.notEqual(validateC2S({ t: 'g.debug', op: 'funds.set', value: 1.5 }), null);
});

test('an ordinary match: g.debug answers BAD_MSG and m.public has no `debug`', () => {
  const h = makeMatch({ mode: 'solo', difficulty: 'FUNNY', humans: 1, seed: 1, fake: true });
  h.start();
  assert.equal(h.m.debug, null);
  assert.deepEqual(dbg(h.m, 'p_0', { op: 'lp.lock', on: true }), { error: ERR.BAD_MSG, detail: 'not a debug match' });
  assert.equal('debug' in h.m.publicView(), false);
  h.m.dispose();
});

test('setup: a debug room without settings plays the ordinary match of its seed; each override leaves the other draws alone', () => {
  for (const [mode, difficulty, bots] of [['coop', 'NORMAL', 1], ['solo', 'HARD', 0], ['coop', 'ABYSS', 2], ['solo', 'FUNNY', 0]]) {
    const plain = makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true });
    const same = makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true, debug: {} });
    assert.deepEqual(setupOf(same.m), setupOf(plain.m), `${mode}/${difficulty}: the same draws`);
    const opt = options(mode, difficulty);
    const p = setupOf(plain.m);
    // the battlefield only: the leaders, the bans and the enemy types are the plain match's
    const stageId = opt.stages.find((s) => s !== p.stageId);
    const st = setupOf(makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true, debug: { stageId } }).m);
    assert.equal(st.stageId, stageId);
    assert.deepEqual({ ...st, stageId: p.stageId }, p, `${mode}/${difficulty}: only the battlefield moved`);
    // the leaders only
    const bossId = opt.bosses.find((b) => b !== p.bossId);
    const bo = setupOf(makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true, debug: { bossId } }).m);
    assert.equal(bo.bossId, bossId);
    assert.deepEqual({ ...bo, bossId: p.bossId }, p);
    // the enemy types: the bans after them are the plain match's draw
    const ft = setupOf(makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true, debug: { factions: ['FLY', 'DOT'] } }).m);
    assert.deepEqual(ft.factions, ['FLY', 'DOT'].sort((a, b) => opt.factionTypes.indexOf(a) - opt.factionTypes.indexOf(b)));
    assert.deepEqual([ft.disabledBonds, ft.bannedChess, ft.bossId, ft.stageId], [p.disabledBonds, p.bannedChess, p.bossId, p.stageId]);
    const slots = ft.schedule.typeSlots.filter((x) => opt.factionTypes.includes(x));
    assert.deepEqual([...new Set(slots)].sort(), ['DOT', 'FLY'], 'the schedule uses the chosen types');
    // the bans: none, or the host's list (the mode's own inactive bonds stay off)
    const none = makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true, debug: { bans: { mode: 'none' } } }).m;
    assert.deepEqual(none.disabledBonds, []);
    assert.deepEqual(none.staticInactiveBonds, p.staticInactiveBonds);
    const two = opt.bonds.slice(0, 2);
    const custom = makeMatch({ mode, difficulty, humans: 1, bots, seed: 77, fake: true, debug: { bans: { mode: 'custom', bonds: two } } }).m;
    assert.deepEqual(custom.disabledBonds, [...two].sort());
    for (const id of custom.bannedChess) {
      const bonds = DATA.chess[id].bonds || [];
      assert.ok(bonds.every((b) => two.includes(b) || custom.staticInactiveBonds.includes(b)), `${id}: every bond off`);
    }
  }
});

test('start state: preset strategies by seat, the start round, level, funds and LP for every player (AI seats too)', () => {
  const h = debugMatch({
    debug: {
      stageId: 'act2autochess_m03', bossId: 'boss_5', hiddenBossId: 'boss_10', bans: { mode: 'custom', bonds: ['yanShip', 'sargonShip'] },
      factions: ['FLY'], start: { round: 6, funds: 50, level: 4, lp: 7, lockLp: true }, bands: { 0: 'band_amiya', 2: 'band_bldsk' },
    },
  });
  const m = h.m;
  assert.deepEqual([m.stageId, m.bossId, m.hiddenBossId, m.factions.join(), m.disabledBonds.join()], ['act2autochess_m03', 'boss_5', 'boss_10', 'FLY', 'sargonShip,yanShip']);
  h.start();
  h.drive(() => m.phase === PHASE.BAND_DRAFT);
  assert.equal(m.draft.picks[HOST], 'band_amiya', 'seat 0 is picked when the draft opens');
  assert.equal(m.draft.picks.ai_0, 'band_bldsk', 'seat 2 (the AI) too');
  assert.equal(m.draft.picks.p_1, undefined, 'seat 1 drafts as usual');
  h.drive(() => m.round === 6 && (m.phase === PHASE.SP_DRAFT || m.phase === PHASE.PREP), { band: 'band_duyaoy' });
  assert.equal(m.players.get('p_1').bandId, 'band_duyaoy');
  for (const ps of m.players.values()) {
    assert.deepEqual([ps.lp, ps.funds, ps.shop.level], [7, 50, 4], ps.playerId);
  }
  assert.deepEqual(m.publicView().debug, { speed: 2, lockLp: true, freezePrep: false, forceHidden: false, startRound: 6 });
  checkInvariants(m);
  m.dispose();
});

test('operations: rights (own state / the host on anyone / host-only switches), phases and targets', () => {
  const h = debugMatch();
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.INFO_CHECK);
  assert.equal(dbg(m, HOST, { op: 'funds.set', value: 5 }).error, ERR.WRONG_PHASE, 'a prep operation outside the prep');
  assert.deepEqual(dbg(m, HOST, { op: 'lp.lock', on: true }), { ok: true }, 'a switch works any time');
  assert.equal(m.publicView().debug.lockLp, true);
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  // another player's state is the host's right; one's own is everybody's
  assert.equal(dbg(m, 'p_1', { op: 'funds.set', value: 9, target: HOST }).error, ERR.NOT_HOST);
  assert.deepEqual(dbg(m, 'p_1', { op: 'funds.set', value: 9 }), { ok: true });
  assert.deepEqual(dbg(m, 'p_1', { op: 'funds.set', value: 9, target: 'p_1' }), { ok: true }, 'naming oneself is fine');
  assert.deepEqual(dbg(m, HOST, { op: 'funds.set', value: 33, target: 'ai_0' }), { ok: true }, 'the host edits an AI seat');
  assert.equal(m.players.get('ai_0').funds, 33);
  assert.equal(dbg(m, HOST, { op: 'funds.set', value: 1, target: 'p_9' }).error, ERR.BAD_TARGET);
  // the host's operations
  for (const msg of [{ op: 'speed.set', value: 4 }, { op: 'prep.freeze', on: true }, { op: 'lp.lock', on: false }, { op: 'round.jump', value: 3 }]) {
    assert.equal(dbg(m, 'p_1', msg).error, ERR.NOT_HOST, msg.op);
  }
  assert.equal(dbg(m, HOST, { op: 'battle.end', mode: 'kill' }).error, ERR.WRONG_PHASE, 'no battle in a prep');
  assert.equal(dbg(m, HOST, { op: 'round.jump', value: 15 }).error, ERR.BAD_TARGET, 'past the boss round');
  assert.equal(dbg(m, HOST, { op: 'level.set', value: 9 }).error, ERR.BAD_TARGET, 'past the highest level');
  assert.equal(dbg(m, HOST, { op: 'layers.set', id: 'noShip', value: 3 }).error, ERR.BAD_TARGET);
  assert.equal(dbg(m, HOST, { op: 'chess.grant', id: 'chess_nope' }).error, ERR.BAD_TARGET);
  assert.equal(dbg(m, HOST, { op: 'item.grant', id: 'chess_item_nope' }).error, ERR.BAD_TARGET);
  assert.equal(dbg(m, HOST, { op: 'speed.set', value: 3 }).error, ERR.BAD_MSG, 'speeds are 1 / 2 / 4');
  assert.equal(dbg(m, HOST, { op: 'funds.set', value: 1000 }).error, ERR.BAD_MSG, 'funds ≤ 999');
  // a player who left is no target; an eliminated one neither
  m.onLeave('p_1');
  assert.equal(dbg(m, HOST, { op: 'funds.set', value: 1, target: 'p_1' }).error, ERR.BAD_TARGET);
  checkInvariants(m);
  m.dispose();
});

test('operations: funds, 调度中心 level (set: nothing triggered; up: an upgrade without its price), LP, layers', () => {
  const h = debugMatch();
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  const ps = m.players.get(HOST);
  assert.deepEqual(dbg(m, HOST, { op: 'funds.set', value: 990 }), { ok: true });
  assert.deepEqual(dbg(m, HOST, { op: 'funds.add', value: 50 }), { ok: true });
  assert.equal(ps.funds, 999, 'a gain never past 999');
  assert.deepEqual(dbg(m, HOST, { op: 'funds.add', value: -1000 + 1 }), { ok: true });
  assert.equal(ps.funds, 0);
  // level.set: written, the shop re-rolled at it, no ticker
  const tickers = () => h.bc.filter((x) => x.t === 'm.ticker' && x.playerId === HOST).length;
  const t0 = tickers();
  assert.deepEqual(dbg(m, HOST, { op: 'level.set', value: 5 }), { ok: true });
  assert.equal(ps.shop.level, 5);
  m.flush(true);
  assert.equal(tickers(), t0, 'no 调度中心 ticker for a set level');
  // level.up: like an upgrade (the ticker), without the price
  ps.funds = 0;
  assert.deepEqual(dbg(m, HOST, { op: 'level.up' }), { ok: true });
  m.flush(true);
  assert.equal(ps.shop.level, 6);
  assert.equal(ps.funds, 0, 'no price');
  assert.ok(tickers() > t0, 'the 调度中心 ticker');
  assert.equal(dbg(m, HOST, { op: 'level.up' }).error, ERR.MAX_LEVEL);
  // LP
  assert.deepEqual(dbg(m, HOST, { op: 'lp.set', value: 123 }), { ok: true });
  assert.equal(ps.lp, 123);
  // layers: set writes (0 removes), add gains like an effect (the cap holds)
  assert.deepEqual(dbg(m, HOST, { op: 'layers.set', id: 'yanShip', value: 40 }), { ok: true });
  assert.equal(ps.layers.yanShip, 40);
  assert.deepEqual(dbg(m, HOST, { op: 'layers.add', id: 'yanShip', value: 999 }), { ok: true });
  assert.equal(ps.layers.yanShip, 999, 'the 999 cap');
  assert.deepEqual(dbg(m, HOST, { op: 'layers.set', id: 'yanShip', value: 0 }), { ok: true });
  assert.equal(ps.layers.yanShip ?? 0, 0);
  checkInvariants(m);
  m.dispose();
});

test('取用: operators and items into the 整备区 without pool copies — ×3 merges into the elite, an elite id gives the elite, HAND_FULL when nothing fits', () => {
  const h = debugMatch();
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  const ps = m.players.get(HOST);
  const base = 'chess_char_1_01_a';
  const golden = DATA.chess[base].goldenId;
  const left = m.pool.entries.get(m.gd.baseIdOf(base))?.left;
  assert.deepEqual(dbg(m, HOST, { op: 'chess.grant', id: base, value: 3 }), { ok: true });
  const held = () => [...ps.hand, ...ps.temp, ...ps.board.values()].filter(Boolean);
  assert.ok(held().some((p) => p.id === golden), 'three copies merged into the elite');
  assert.equal(held().filter((p) => p.id === base).length, 0);
  assert.equal(m.pool.entries.get(m.gd.baseIdOf(base))?.left, left, 'the shared pool is untouched');
  assert.deepEqual(dbg(m, HOST, { op: 'chess.grant', id: DATA.chess.chess_char_1_02_a.goldenId }), { ok: true });
  assert.ok(held().some((p) => p.id === DATA.chess.chess_char_1_02_a.goldenId));
  checkInvariants(m);
  // items, until the 整备区 and the 临时整备区 are full
  const items = Object.keys(DATA.items).filter((id) => /_a$/.test(id));
  let i = 0;
  let res = null;
  for (; i < items.length; i++) {
    res = dbg(m, HOST, { op: 'item.grant', id: items[i] });
    if (!res.ok) break;
  }
  assert.equal(res.error, ERR.HAND_FULL, `HAND_FULL after ${i} items`);
  assert.ok(ps.hand.every(Boolean) && ps.temp.every(Boolean), 'everything full');
  assert.equal(dbg(m, HOST, { op: 'chess.grant', id: 'chess_char_1_03_a' }).error, ERR.HAND_FULL);
  checkInvariants(m);
  m.dispose();
});

test('speed: the field clocks are rebased (no jump), later game time runs at the new pace, new battles start at it', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, bots: 1, seed: 5, clientCombat: true, pace: 'paced', instant: false,
    debug: { start: { round: 3, level: 3 } }, hostId: () => HOST });
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.COMBAT);
  h.sched.advance(6000);
  const gt = () => m.fields.map((f) => Number(m._fieldElapsed(f).toFixed(3)));
  const before = gt();
  const left = m.deadline - m.sched.now();
  assert.deepEqual(dbg(m, HOST, { op: 'speed.set', value: 4 }), { ok: true });
  assert.deepEqual(gt(), before, 'no battle jumps');
  assert.ok(Math.abs((m.deadline - m.sched.now()) - left / 2) <= 2, 'the HUD deadline at the new pace');
  assert.equal(m.publicView().debug.speed, 4);
  h.sched.advance(1000);
  assert.deepEqual(gt(), before.map((x) => Number((x + 4).toFixed(3))), '1 real s = 4 game s');
  // the next battle starts at 4×
  const starts = h.allTo(HOST, 'b.start').length;
  h.drive(() => m.phase === PHASE.COMBAT && m.round === 4);
  const next = h.allTo(HOST, 'b.start').slice(starts).find((x) => x.fieldId === `n:${HOST}`);
  assert.equal(next?.speed, 4);
  assert.deepEqual(h.logs.error, []);
  m.dispose();
});

test('pause: the host pauses a co-op debug battle (联防 too), anyone else is refused; ending it: natural / leak / kill', () => {
  const lpAfter = {};
  for (const mode of ['natural', 'leak', 'kill']) {
    const h = makeMatch({ mode: 'coop', difficulty: 'HARD', humans: 2, bots: 1, seed: 5, clientCombat: true, pace: 'paced', instant: false,
      debug: { start: { round: 3, level: 3 } }, hostId: () => HOST });
    const m = h.m;
    h.start();
    h.drive(() => m.phase === PHASE.COMBAT);
    h.sched.advance(6000);
    const lpBefore = [...m.players.values()].map((p) => p.lp);
    assert.equal(m.handle('p_1', { t: 'g.pause', on: true }).error, ERR.NOT_HOST);
    assert.deepEqual(m.handle(HOST, { t: 'g.pause', on: true }), { ok: true });
    assert.equal(m.publicView().paused, true);
    assert.equal(dbg(m, HOST, { op: 'battle.end', mode: 'win' }).error, ERR.BAD_TARGET, 'win / lose end a leader battle only');
    h.sent.length = 0;
    assert.deepEqual(dbg(m, HOST, { op: 'battle.end', mode }), { ok: true });
    const ends = h.sent.filter(([, x]) => x.t === 'b.end').map(([, x]) => x.reason);
    assert.ok(ends.length > 0 && ends.every((r) => r === { natural: 'takeover', leak: 'timeout', kill: 'forced' }[mode]), `${mode}: b.end ${ends}`);
    for (const f of m.fields) {
      assert.equal(f.done, true);
      const counted = Object.values(f.result.perPlayer).reduce((s, p) => s + p.leaked.filter((l) => l.counted !== false).length, 0);
      if (mode === 'kill') assert.deepEqual([f.result.reason, counted], ['forced', 0], `${f.fieldId}: nothing more counted`);
      if (mode === 'leak') assert.equal(f.result.reason, 'timeout');
      if (mode === 'natural') assert.notEqual(f.result.reason, 'forced');
    }
    h.drive(() => m.phase === PHASE.SETTLE || m.phase === PHASE.UNITE || h.ended != null);
    assert.equal(m.paused, false, 'the battle phase ending drops the pause');
    if (m.phase === PHASE.UNITE) {
      h.sched.advance(2000);
      assert.deepEqual(m.handle(HOST, { t: 'g.pause', on: true }), { ok: true }, 'the host pauses 联防');
      assert.equal(m.paused, true);
      assert.deepEqual(m.handle(HOST, { t: 'g.pause', on: false }), { ok: true });
      assert.equal(m.paused, false);
    }
    h.drive(() => m.phase === PHASE.PREP && m.round === 4);
    lpAfter[mode] = [...m.players.values()].map((p) => p.lp);
    if (mode === 'kill') assert.deepEqual(lpAfter.kill, lpBefore, 'kill: no LP lost');
    if (mode === 'leak') assert.ok(lpAfter.leak.some((lp, i) => lp < lpBefore[i]), 'leak: the enemies on the field cost LP');
    assert.deepEqual(h.logs.error, []);
    checkInvariants(m);
    m.dispose();
  }
});

test('an ordinary co-op match still never pauses', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, seed: 3, fake: true });
  h.start();
  assert.equal(h.m.handle('p_0', { t: 'g.pause', on: true }).error, ERR.WRONG_PHASE);
  h.m.dispose();
});

test('the prep countdown frozen: what was left is kept, a prep that starts frozen is untimed until unfrozen', () => {
  const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 2, bots: 0, seed: 21, clientCombat: true, pace: 'paced', instant: false,
    debug: { start: { round: 2 } }, hostId: () => HOST });
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.PREP, { ready: false });
  h.sched.advance(5000);
  const left = m.deadline - m.sched.now();
  assert.ok(left > 0);
  assert.deepEqual(dbg(m, HOST, { op: 'prep.freeze', on: true }), { ok: true });
  assert.equal(m.publicView().debug.freezePrep, true);
  assert.equal(m.deadline, 0, 'no countdown while frozen');
  h.sched.advance(10 * 60 * 1000);
  assert.equal(m.phase, PHASE.PREP, 'the prep waits');
  assert.deepEqual(dbg(m, HOST, { op: 'prep.freeze', on: false }), { ok: true });
  assert.equal(m.deadline - m.sched.now(), left, 'the rest of the prep');
  // frozen again, then the next prep starts untimed
  assert.deepEqual(dbg(m, HOST, { op: 'prep.freeze', on: true }), { ok: true });
  h.drive(() => m.phase === PHASE.PREP && m.round === 3);
  assert.equal(m.deadline, 0, 'a prep that starts frozen is untimed');
  h.sched.advance(10 * 60 * 1000);
  assert.equal(m.phase, PHASE.PREP);
  assert.deepEqual(dbg(m, HOST, { op: 'prep.freeze', on: false }), { ok: true });
  assert.equal(m.deadline - m.sched.now(), m.scaled(m.gd.prepTime(3) * 1000), 'unfrozen: the whole prep time');
  assert.deepEqual(h.logs.error, []);
  m.dispose();
});

test('round.jump: the prep ends without a battle, the round starts; the boss round is the Final Assault — win / lose there', () => {
  const h = debugMatch();
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.PREP && m.round === 1);
  const combats = () => h.bc.filter((x) => x.t === 'm.public' && x.phase === PHASE.COMBAT).length;
  m.flush(true);
  const c0 = combats();
  assert.deepEqual(dbg(m, HOST, { op: 'round.jump', value: 5 }), { ok: true });
  assert.equal(m.round, 5);
  h.drive(() => m.phase === PHASE.PREP && m.round === 5);
  m.flush(true);
  assert.equal(combats(), c0, 'no battle on the way');
  assert.deepEqual(dbg(m, HOST, { op: 'round.jump', value: m.gd.bossRound }), { ok: true });
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  assert.equal(dbg(m, HOST, { op: 'battle.end', mode: 'leak' }).error, ERR.BAD_TARGET);
  assert.equal(dbg(m, HOST, { op: 'round.jump', value: 3 }).error, ERR.WRONG_PHASE, 'from a prep only');
  assert.deepEqual(dbg(m, HOST, { op: 'lp.set', value: 9 }), { ok: true }, 'the team LP in a leader battle');
  assert.equal(m.teamLp, 9);
  assert.deepEqual(dbg(m, HOST, { op: 'battle.end', mode: 'lose' }), { ok: true });
  h.drive(() => h.ended != null);
  assert.equal(h.ended.victory, false);
  checkInvariants(m);
  m.dispose();
});

test('the LP lock: settlement stops at 1 LP (nobody eliminated), the team LP at 1; lose still empties it; forceHidden opens the Hidden Core', () => {
  // settlement: everybody leaks (no 联防) on 2 LP — the host keeps 50 LP
  for (const lock of [true, false]) {
    const h = debugMatch({ debug: { start: { lp: 2, lockLp: lock } }, script: (b) => ({ duration: 3, leaks: Object.fromEntries(b.players.map((p) => [p, 10])) }) });
    const m = h.m;
    h.start();
    h.drive(() => m.phase === PHASE.PREP && m.round === 1);
    assert.deepEqual(dbg(m, HOST, { op: 'lp.set', value: 50 }), { ok: true });
    h.drive(() => (m.phase === PHASE.PREP && m.round === 2) || h.ended != null);
    const others = ['p_1', 'ai_0'].map((id) => m.players.get(id));
    assert.ok(m.players.get(HOST).lp < 50, 'the leaks cost LP');
    if (lock) {
      assert.deepEqual(others.map((p) => [p.lp, p.alive]), [[1, true], [1, true]], 'locked: 1 LP left');
    } else {
      assert.deepEqual(others.map((p) => p.alive), [false, false], 'unlocked: eliminated');
      assert.equal(dbg(m, HOST, { op: 'funds.set', value: 1, target: 'p_1' }).error, ERR.ELIMINATED, 'an eliminated player is no target');
    }
    checkInvariants(m);
    m.dispose();
  }
  // the team LP and forceHidden (solo, real combat in the browser stand-in)
  const h = makeMatch({ mode: 'solo', difficulty: 'HARD', humans: 1, seed: 8, clientCombat: true, pace: 'paced', instant: false,
    debug: { start: { round: 14, lockLp: true }, forceHidden: true, hiddenBossId: 'boss_8' } });
  const m = h.m;
  h.start();
  h.drive(() => m.phase === PHASE.FINAL_ASSAULT);
  h.sched.advance(3000);
  m._teamLpLoss(1000);
  assert.equal(m.teamLp, 1, 'locked: the team LP stays at 1');
  assert.deepEqual(dbg(m, 'p_0', { op: 'battle.end', mode: 'win' }), { ok: true });
  h.drive(() => m.phase === PHASE.HIDDEN_CORE || h.ended != null);
  assert.deepEqual([m.phase, m.round, m.hiddenBossId], [PHASE.HIDDEN_CORE, 15, 'boss_8'], 'forceHidden: the Hidden Core whatever the conditions');
  h.sched.advance(2000);
  assert.deepEqual(dbg(m, 'p_0', { op: 'battle.end', mode: 'lose' }), { ok: true });
  assert.equal(m.teamLp, 0, 'lose empties the team LP whatever the lock');
  h.drive(() => h.ended != null);
  assert.deepEqual(h.logs.error, []);
  m.dispose();
});

test('server-run combat (SP_COMBAT=server): ending a battle works the same way', () => {
  for (const mode of ['natural', 'leak', 'kill']) {
    const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 3, clientCombat: false, instant: false, debug: {}, hostId: () => HOST });
    const m = h.m;
    h.start();
    h.drive(() => m.phase === PHASE.COMBAT);
    h.sched.advance(4000);
    assert.deepEqual(dbg(m, HOST, { op: 'battle.end', mode }), { ok: true }, mode);
    h.drive(() => m.phase !== PHASE.COMBAT || h.ended != null);
    assert.notEqual(m.phase, PHASE.COMBAT);
    assert.deepEqual(h.logs.error, []);
    m.dispose();
  }
});

/** A valid-shaped random g.debug of the debug fuzz. */
function randomDebug(rng, ids) {
  const op = rng.pick(Object.keys(DEBUG_OPS));
  const spec = DEBUG_OPS[op];
  const msg = { t: 'g.debug', op };
  if (spec.target && rng() < 0.3) msg.target = rng.pick(ids.players);
  if (spec.id) msg.id = rng.pick(op.startsWith('layers') ? ids.bonds : op === 'chess.grant' ? ids.chess : ids.items);
  if (spec.values) msg.value = rng.pick(spec.values);
  else if (spec.value && !(spec.optional?.includes('value') && rng() < 0.5)) {
    const [lo, hi] = spec.value;
    msg.value = rng() < 0.7 ? lo + rng.int(Math.min(hi - lo + 1, 20)) : lo + rng.int(hi - lo + 1);
  }
  if (spec.on) msg.on = rng() < 0.5;
  if (spec.mode) msg.mode = rng.pick(END_MODES);
  return msg;
}

test('fuzz: a debug room under random operations, intents and time keeps the invariants and ends', () => {
  const ids = { bonds: Object.keys(DATA.bonds), chess: Object.keys(DATA.chess).filter((id) => !DATA.chess[id].isDiy), items: Object.keys(DATA.items) };
  let ops = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const rng = createRng(seed * 104729);
    const mode = rng() < 0.3 ? 'solo' : 'coop';
    const difficulty = rng.pick(['FUNNY', 'NORMAL', 'HARD', 'ABYSS']);
    const humans = mode === 'solo' ? 1 : 1 + rng.int(2);
    const bots = mode === 'solo' ? 0 : rng.int(3);
    const opt = options(mode, difficulty);
    const h = makeMatch({ mode, difficulty, humans, bots, seed, fake: true, captureFrames: false, checkFrames: true, hostId: () => HOST,
      script: () => ({ duration: 2 + rng.int(6), leaks: {} }),
      debug: { start: { round: 1 + rng.int(opt.bossRound), lockLp: rng() < 0.5 }, stageId: rng.pick(opt.stages), factions: [rng.pick(opt.factionTypes)] } });
    const m = h.m;
    m.start();
    ids.players = [...m.players.keys()];
    const humanIds = ids.players.filter((id) => !m.players.get(id).isBot);
    for (let step = 0; step < 600 && h.ended == null; step++) {
      const r = rng();
      const pid = rng.pick(humanIds);
      if (r < 0.45) {
        const msg = randomDebug(rng, ids);
        assert.equal(validateC2S(msg), null, JSON.stringify(msg));
        const res = m.handle(pid, msg);
        ops++;
        assert.ok(res && (res.ok === true || Object.hasOwn(ERR, res.error)), `bad reply ${JSON.stringify(res)} to ${JSON.stringify(msg)}`);
        assert.notEqual(res.error, ERR.INTERNAL, JSON.stringify(msg));
      } else if (r < 0.6) {
        const ps = m.players.get(pid);
        if (m.phase === PHASE.PREP && !ps.tempEmpty) ps.resolveTemp();
        m.handle(pid, rng() < 0.5 ? { t: 'g.ready', ready: true } : { t: 'g.infoReady' });
      } else if (r < 0.9) {
        h.sched.advance(rng.int(4000));
      } else {
        for (let k = 0; k < 20; k++) if (!h.sched.runNext()) break;
      }
      if (step % 15 === 0) checkInvariants(m);
    }
    for (const ps of m.players.values()) if (!ps.isBot && !ps.left) m.handle(ps.playerId, { t: 'g.autoplay', on: true });
    dbg(m, HOST, { op: 'prep.freeze', on: false });
    dbg(m, HOST, { op: 'lp.lock', on: false });
    h.drive(() => h.ended != null);
    assert.ok(h.ended, `seed ${seed}: the match ended (${m.phase} R${m.round})`);
    assert.equal(m.errorCount, 0, `seed ${seed}: ${JSON.stringify(m.errors.slice(0, 3))}`);
    assert.deepEqual(h.badFrames, []);
    checkInvariants(m);
    m.dispose();
  }
  assert.ok(ops > 1500, `${ops} operations`);
});
