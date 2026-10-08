// test/lobby-debug.test.js — debug rooms in the lobby (DESIGN §27, server/lobby.js): room.create { debug } opens one
// (DEBUG_OFF on a server started with SP_DEBUG=0 / debugRooms: false — every welcome says debugRooms), DBUG is never a
// room's key, room.join / room.spectate of a debug room need debugAck (else DEBUG_CONFIRM), the host's room.debugConfig
// (lenient, re-checked on a difficulty change, un-readies the others, LOBBY only), room.state.debug / debugConfig, and
// the match the room starts: its settings, the room's host, the room's seed; g.debug end to end with the real Match.
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { parseDebugRooms, lobbyOptionsFrom } from '../server/http/config.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR, DEBUG_ROOM_CODE } from '../shared/constants.js';
import { validateC2S } from '../shared/protocol.js';
import { defaultDebugConfig } from '../shared/debug.js';

/** StubMatch that records the options the lobby handed it. */
class RecordingMatch extends StubMatch {
  static made = [];
  constructor(opts) {
    super(opts);
    RecordingMatch.made.push(opts);
  }
}

function clientPool(getUrl) {
  const open = new Set();
  return {
    async player(name) {
      const c = await TestClient.connect(getUrl());
      open.add(c);
      const w = await c.hello(name);
      c.id = w.playerId;
      c.welcome = w;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
async function createDebugRoom(c, { mode = 'coop', difficulty = 'NORMAL' } = {}) {
  await ok(c, { t: 'room.create', mode, difficulty, debug: true });
  return c.waitFor('room.state', (s) => s.hostId === c.id);
}

test('protocol: room.create { debug }, room.join / room.spectate { debugAck }, room.debugConfig { config }', () => {
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'HARD', debug: true }), null);
  assert.equal(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'HARD' }), null, 'debug is optional');
  assert.notEqual(validateC2S({ t: 'room.create', mode: 'coop', difficulty: 'HARD', debug: 'yes' }), null);
  assert.equal(validateC2S({ t: 'room.join', code: 'ABCD', debugAck: true }), null);
  assert.equal(validateC2S({ t: 'room.spectate', code: 'ABCD', debugAck: true }), null);
  assert.notEqual(validateC2S({ t: 'room.join', code: 'ABCD', debugAck: 1 }), null);
  assert.equal(validateC2S({ t: 'room.debugConfig', config: {} }), null);
  assert.equal(validateC2S({ t: 'room.debugConfig', config: defaultDebugConfig() }), null);
  assert.notEqual(validateC2S({ t: 'room.debugConfig', config: { start: { funds: 5000 } } }), null);
  assert.notEqual(validateC2S({ t: 'room.debugConfig' }), null);
});

test('SP_DEBUG: debug rooms are open unless switched off; the startServer() option wins', () => {
  for (const v of [undefined, '', '1', 'true', 'on', 'yes']) assert.equal(parseDebugRooms(v), true, String(v));
  for (const v of ['0', 'false', 'off', 'no', 'never', ' OFF ']) assert.equal(parseDebugRooms(v), false, v);
  const prev = process.env.SP_DEBUG;
  try {
    process.env.SP_DEBUG = '0';
    assert.equal(lobbyOptionsFrom({}).debugRooms, false);
    assert.equal(lobbyOptionsFrom({ debugRooms: true }).debugRooms, true, 'the option wins');
    delete process.env.SP_DEBUG;
    assert.equal(lobbyOptionsFrom({}).debugRooms, true);
    assert.equal(lobbyOptionsFrom({ debugRooms: false }).debugRooms, false);
  } finally {
    if (prev === undefined) delete process.env.SP_DEBUG; else process.env.SP_DEBUG = prev;
  }
});

describe('debug rooms (lobby)', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: RecordingMatch, lobbyGraceMs: 60_000, debugRooms: true });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('room.create { debug }: a debug room with an ordinary key and the default settings; DBUG itself is no room', async () => {
    const host = await pool.player('Host');
    assert.equal(host.welcome.debugRooms, true, 'the welcome says debug rooms are open');
    await err(host, { t: 'room.join', code: DEBUG_ROOM_CODE }, ERR.ROOM_NOT_FOUND);
    const st = await createDebugRoom(host);
    assert.notEqual(st.code, DEBUG_ROOM_CODE);
    assert.match(st.code, /^[A-Z0-9]{4}$/);
    assert.equal(st.debug, true);
    assert.deepEqual(st.debugConfig, defaultDebugConfig());
    const other = await pool.player('Other');
    await ok(other, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const plain = await other.waitFor('room.state', (s) => s.hostId === other.id);
    assert.equal('debug' in plain, false, 'an ordinary room carries no debug fields');
    assert.equal('debugConfig' in plain, false);
  });

  test('entering a debug room by its key asks first: DEBUG_CONFIRM, then debugAck; a spectator taking a seat is not asked again', async () => {
    const host = await pool.player('Host');
    const st = await createDebugRoom(host);
    const guest = await pool.player('Guest');
    await err(guest, { t: 'room.join', code: st.code }, ERR.DEBUG_CONFIRM);
    await ok(guest, { t: 'room.join', code: st.code, debugAck: true });
    const joined = await guest.waitFor('room.state', (s) => !!seatOf(s, guest.id));
    assert.equal(joined.debug, true);
    const watcher = await pool.player('Watcher');
    await err(watcher, { t: 'room.spectate', code: st.code }, ERR.DEBUG_CONFIRM);
    await ok(watcher, { t: 'room.spectate', code: st.code, debugAck: true });
    await watcher.waitFor('room.state', (s) => s.spectators.some((x) => x.playerId === watcher.id));
    await ok(watcher, { t: 'room.join', code: st.code });
    await watcher.waitFor('room.state', (s) => !!seatOf(s, watcher.id));
  });

  test('room.debugConfig: the host\'s, checked leniently against the mode, broadcast, un-readying the others; re-checked on a difficulty change', async () => {
    const host = await pool.player('Host');
    const st = await createDebugRoom(host, { difficulty: 'NORMAL' });
    const guest = await pool.player('Guest');
    await ok(guest, { t: 'room.join', code: st.code, debugAck: true });
    await ok(guest, { t: 'room.ready', ready: true });
    await host.waitFor('room.state', (s) => seatOf(s, guest.id)?.ready);
    await err(guest, { t: 'room.debugConfig', config: { seed: 1 } }, ERR.NOT_HOST);
    guest.clearInbox();
    await ok(host, { t: 'room.debugConfig', config: { seed: 99, stageId: 'nope', hiddenBossId: 'boss_9', forceHidden: true, start: { round: 40, funds: 12 }, bands: { 0: 'band_amiya', 1: 'band_amiya' } } });
    const next = await guest.waitFor('room.state', (s) => s.debugConfig?.seed === 99);
    assert.deepEqual(next.debugConfig, {
      ...defaultDebugConfig(), seed: 99, hiddenBossId: 'boss_9', forceHidden: true,
      start: { ...defaultDebugConfig().start, round: 14, funds: 12 }, bands: { 0: 'band_amiya' },
    });
    assert.equal(seatOf(next, guest.id).ready, false, 'a change un-readies the other humans');
    // 标准 has no Hidden Core: the difficulty change clears its settings
    await ok(host, { t: 'room.setDifficulty', difficulty: 'FUNNY' });
    const funny = await guest.waitFor('room.state', (s) => s.difficulty === 'FUNNY');
    assert.deepEqual([funny.debugConfig.hiddenBossId, funny.debugConfig.forceHidden, funny.debugConfig.seed], [null, false, 99]);
    // a spectator, an ordinary room
    const watcher = await pool.player('Watcher');
    await ok(watcher, { t: 'room.spectate', code: st.code, debugAck: true });
    await err(watcher, { t: 'room.debugConfig', config: {} }, ERR.SPECTATOR);
    const other = await pool.player('Other');
    await ok(other, { t: 'room.create', mode: 'solo', difficulty: 'HARD' });
    await err(other, { t: 'room.debugConfig', config: {} }, ERR.BAD_MSG);
  });

  test('the match: the room\'s settings, its host and its seed; no settings change while it runs', async () => {
    const host = await pool.player('Host');
    const st = await createDebugRoom(host, { difficulty: 'HARD' });
    await ok(host, { t: 'room.debugConfig', config: { seed: 4242, start: { round: 3, lockLp: true } } });
    const set = await host.waitFor('room.state', (s) => s.debugConfig?.seed === 4242);
    RecordingMatch.made.length = 0;
    await ok(host, { t: 'room.start' });
    await host.waitFor('room.state', (s) => s.code === st.code && s.inMatch);
    const opts = RecordingMatch.made[0];
    assert.ok(opts, 'a match was made');
    assert.deepEqual(opts.debug, set.debugConfig);
    assert.ok(Object.isFrozen(opts.debug) && Object.isFrozen(opts.debug.start), 'frozen settings');
    assert.equal(opts.seed, 4242, 'the room\'s seed');
    assert.equal(opts.hostId(), host.id);
    await err(host, { t: 'room.debugConfig', config: {} }, ERR.ROOM_STARTED);
    // an ordinary room's match: none of it
    const other = await pool.player('Other');
    await ok(other, { t: 'room.create', mode: 'solo', difficulty: 'HARD' });
    await other.waitFor('room.state', (s) => s.hostId === other.id);
    await ok(other, { t: 'room.start' });
    await other.waitFor('room.state', (s) => s.inMatch);
    const plain = RecordingMatch.made[1];
    assert.equal(plain.debug, undefined);
    assert.equal(plain.hostId, undefined);
  });
});

describe('debug rooms switched off (SP_DEBUG=0)', () => {
  let srv;
  let pool;
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: quietLog().log, MatchClass: StubMatch, debugRooms: false });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  after(async () => { await pool.closeAll(); await srv?.close(); });

  test('the welcome says so and room.create { debug } answers DEBUG_OFF; ordinary rooms are unaffected', async () => {
    const c = await pool.player('Doc');
    assert.equal(c.welcome.debugRooms, false);
    await err(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL', debug: true }, ERR.DEBUG_OFF);
    await ok(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  });
});

describe('g.debug with the real match', () => {
  let srv;
  let pool;
  const cap = quietLog();
  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, debugRooms: true });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  after(async () => {
    await pool.closeAll();
    await srv?.close();
    assert.deepEqual(cap.errors, []);
  });

  test('m.public.debug follows the switches; a prep operation outside the prep is refused; an ordinary match refuses g.debug', async () => {
    const host = await pool.player('Host');
    await createDebugRoom(host, { mode: 'solo', difficulty: 'FUNNY' });
    await ok(host, { t: 'room.start' });
    const first = await host.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 5000);
    assert.deepEqual(first.debug, { speed: 2, lockLp: false, freezePrep: false, forceHidden: false, startRound: 1 });
    await err(host, { t: 'g.debug', op: 'funds.set', value: 5 }, ERR.WRONG_PHASE);
    await ok(host, { t: 'g.debug', op: 'lp.lock', on: true });
    await host.waitFor('m.public', (p) => p.debug?.lockLp === true, 3000);
    await ok(host, { t: 'g.debug', op: 'speed.set', value: 4 });
    await host.waitFor('m.public', (p) => p.debug?.speed === 4, 3000);
    await err(host, { t: 'g.debug', op: 'speed.set', value: 3 }, ERR.BAD_MSG);
    await ok(host, { t: 'g.leave' });

    const other = await pool.player('Other');
    await ok(other, { t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
    await ok(other, { t: 'room.start' });
    const plain = await other.waitFor('m.public', (p) => p.phase === 'INFO_CHECK', 5000);
    assert.equal('debug' in plain, false);
    await err(other, { t: 'g.debug', op: 'lp.lock', on: true }, ERR.BAD_MSG);
    await ok(other, { t: 'g.leave' });
  });
});
