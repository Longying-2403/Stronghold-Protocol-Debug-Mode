// server/match/match/debug.js — Match methods: debug rooms (DESIGN §27, a remake tool for testing; the official game has
// none). A match is a debug match when the lobby hands it a debug room's settings (opts.debug, shared/debug.js); every
// ordinary match has `this.debug === null` and none of this runs.
//   * Setup (Match.js): the battlefield, the 特训敌人 types and the leaders replace what setupMatchWaves drew, the disabled
//     bonds are the official draw, none or the host's list (pool.js bansFor), the seed is the room's when set (lobby).
//   * Start state: the strategies the room assigned are picked when the draft opens (the other seats draft as usual);
//     the match starts at `start.round`; the first round's shop is rolled at `start.level`, then `start.funds` and
//     `start.lp` replace what the round start gave — every alive player, AI seats included. `start.lockLp` is the
//     LP lock's first state; `forceHidden` opens the Hidden Core after a won Final Assault whatever the conditions.
//   * The LP lock: settlement and the team LP never take a player / the team below 1 (no elimination, no defeat by LP);
//     `battle.end lose` still empties the team LP.
//   * g.debug { op, target?, id?, value?, on?, mode? } (shared/debug.js DEBUG_OPS): the state operations — funds,
//     the 调度中心 level (`level.set` re-rolls the shop at the new level with nothing triggered; `level.up` is an upgrade
//     without the price: the new slots, the ticker and the onLevelUp effects), LP (the team LP while it exists), bond
//     layers (`layers.set` writes the count; `layers.add` gains like any effect: onLayers fires, the 999 cap holds) and
//     取用 (chess / items into the hand, overflow temp, holding no shared-pool copy; merges happen as usual) — in the
//     prep only; the host's operations — the LP lock, the battle speed (1 / 2 / 4: every field clock is rebased so no
//     battle jumps; the browsers follow m.public.debug.speed), freezing the prep countdown, ending the running battle
//     phase (normal / 联防: `natural` = the battle's own result now, `leak` / `kill` = cut at the field clock, the enemies
//     left counted as leaked / not counted; boss rounds: `win` / `lose`) and jumping to a round from a prep (the prep
//     ends, no battle, round N starts — the boss round is the Final Assault). A target other than the requester is the
//     host's right; a target must be alive. The co-op pause (g.pause, pause.js) is the host's in a debug match.
// Installed on Match.prototype by server/match/Match.js (a method container: never instantiated; `this` is the match).

import { PHASE, ERR } from '../../../shared/constants.js';
import { DEBUG_LIMITS, DEBUG_OPS, checkDebugOp, debugOptions, normalizeDebugConfig } from '../../../shared/debug.js';
import { TICK } from '../../sim/constants.js';
import { runHeadless, syntheticResult, HARD_CAP_SECONDS } from '../fields.js';
import { OK, fail } from './common.js';

/** The phases whose battles a speed change rebases (field clocks, the HUD deadline). */
const BATTLE_PHASES = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

/**
 * The debug state of a match: its settings (checked again against this match's data and mode) and the live switches.
 * @param {any} config the debug room's settings (opts.debug)
 * @param {any} data the match's game data
 * @param {string} modeId
 */
export function createDebugState(config, data, modeId) {
  const c = normalizeDebugConfig(config, debugOptions(data, modeId));
  return {
    config: c,
    /** the LP lock (g.debug lp.lock; its first state: start.lockLp) */
    lockLp: !!c.start.lockLp,
    /** the prep countdown is frozen (g.debug prep.freeze) — `frozenLeft` real ms of the prep it froze (`frozenRound`) */
    freezePrep: false,
    frozenLeft: null,
    frozenRound: null,
    /** the start state was applied (the first round start) */
    startDone: false,
    /** round.jump: the round the ending prep goes to */
    jumpTo: null,
  };
}

export class MatchDebug {
  /** The room's host now (debug matches: the host-only operations); without the lobby's callback the first human still in. */
  _isDebugHost(playerId) {
    if (this.hostIdFn) {
      try { return this.hostIdFn() === playerId; } catch { return false; }
    }
    const first = this.order.find((p) => !p.isBot && !p.left);
    return !!first && first.playerId === playerId;
  }

  /** m.public.debug: the live switches every client shows (the DEBUG mark, the panel's state, the runner's speed). */
  _debugView() {
    const d = this.debug;
    return { speed: this.gameSpeed, lockLp: !!d.lockLp, freezePrep: !!d.freezePrep, forceHidden: !!d.config.forceHidden, startRound: d.config.start.round };
  }

  /** The round the match starts with: a debug room's start.round (≤ the boss round), else 1. */
  _firstRound() {
    const r = this.debug ? this.debug.config.start.round : 1;
    return Number.isInteger(r) && r >= 1 && r <= this.gd.bossRound ? r : 1;
  }

  /** The draft opens: the strategies the room assigned by seat are picked (never one a teammate holds, 队友已选). */
  _debugPresetBands() {
    const d = this.draft;
    const bands = this.debug.config.bands;
    for (const ps of this.order) {
      const id = Object.hasOwn(bands, String(ps.seat)) ? bands[String(ps.seat)] : null;
      if (typeof id !== 'string' || !this.gd.bandAllowed(id) || this.bandTaken(id, ps.playerId)) continue;
      d.picks[ps.playerId] = id;
      ps.bandId = id;
      ps.lp = this.gd.startLp(id);
      this.markPrivate(ps);
    }
  }

  /** The first round, before PlayerState.startRound: the 调度中心 level its shop is rolled at. */
  _debugStartLevel(alive) {
    const level = this.debug.config.start.level;
    if (!Number.isInteger(level)) return;
    const lv = Math.max(1, Math.min(this.gd.maxShopLevel, level));
    for (const ps of alive) {
      ps.shop.level = lv;
      ps.shop.upgradePrice = this.gd.upgradeBase(lv) ?? 0;
    }
  }

  /** The first round, after its start (income, onRoundStart): the start funds and LP replace what it gave. */
  _debugStartState(alive) {
    const { funds, lp } = this.debug.config.start;
    for (const ps of alive) {
      if (Number.isInteger(funds)) { ps.funds = funds; ps.dirty(); }
      if (Number.isInteger(lp)) { ps.lp = lp; ps.dirty(); }
    }
    this.debug.startDone = true;
  }

  /** The LP lock's floor: a locked match never takes anyone below 1. */
  _lpLocked() { return !!(this.debug && this.debug.lockLp); }

  /**
   * g.debug (header). Never throws (the platform isolates it anyway); answers OK or an error.
   * @param {import('../PlayerState.js').PlayerState} ps
   * @param {any} msg
   */
  debugOp(ps, msg) {
    if (!this.debug) return fail(ERR.BAD_MSG, 'not a debug match');
    const c = checkDebugOp(msg);
    if (!('ok' in c)) return fail(ERR.BAD_MSG, c.detail);
    const spec = DEBUG_OPS[c.op];
    const host = this._isDebugHost(ps.playerId);
    if (spec.host && !host) return fail(ERR.NOT_HOST);
    let target = ps;
    if (spec.target) {
      if (c.target != null && c.target !== ps.playerId) {
        if (!host) return fail(ERR.NOT_HOST, 'another player: the host only');
        target = this.players.get(c.target);
        if (!target) return fail(ERR.BAD_TARGET, 'no such player');
      }
      if (target.left) return fail(ERR.BAD_TARGET, 'the player left');
      if (!target.alive) return fail(ERR.ELIMINATED);
    }
    if (spec.prep && this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE, 'in a prep only');
    switch (c.op) {
      case 'funds.set': target.funds = c.value; target.dirty(); return OK;
      case 'funds.add': {
        // an add never pushes funds past the debug limit (a player above it keeps what it has)
        const v = c.value > 0 ? Math.min(c.value, Math.max(0, DEBUG_LIMITS.funds - target.funds)) : c.value;
        target.addFunds(v, { reason: 'debug' });
        return OK;
      }
      case 'level.set': return this._debugSetLevel(target, c.value);
      case 'level.up': return this._debugLevelUp(target);
      case 'lp.set': return this._debugSetLp(target, c.value);
      case 'lp.lock':
        this.debug.lockLp = c.on;
        this.markPublic();
        return OK;
      case 'layers.set': {
        if (!this.gd.bond(c.id)) return fail(ERR.BAD_TARGET, 'unknown bond');
        if (c.value > 0) target.layers[c.id] = c.value;
        else delete target.layers[c.id];
        target.recompute();
        return OK;
      }
      case 'layers.add':
        if (!this.gd.bond(c.id)) return fail(ERR.BAD_TARGET, 'unknown bond');
        target.addLayers(c.id, c.value, { reason: 'debug' });
        return OK;
      case 'chess.grant': return this._debugGrant(target, 'chess', c.id, c.value ?? 1);
      case 'item.grant': return this._debugGrant(target, 'item', c.id, c.value ?? 1);
      case 'speed.set':
        this._debugSetSpeed(c.value);
        return OK;
      case 'prep.freeze':
        this._debugFreezePrep(c.on);
        return OK;
      case 'battle.end': return this._debugEndBattle(c.mode);
      case 'round.jump': return this._debugJump(c.value);
      default: return fail(ERR.BAD_MSG);
    }
  }

  /** level.set: the level written, the shop re-rolled at it (frozen cards kept), nothing triggered. */
  _debugSetLevel(ps, level) {
    if (level > this.gd.maxShopLevel) return fail(ERR.BAD_TARGET, `the highest level is ${this.gd.maxShopLevel}`);
    ps.shop.level = level;
    ps.shop.upgradePrice = this.gd.upgradeBase(level) ?? 0;
    ps.rollShop({ keepFrozen: true });
    ps.recompute();
    return OK;
  }

  /** level.up: an upgrade without its price (player/economy.js levelUp — the new slots, the ticker, onLevelUp). */
  _debugLevelUp(ps) {
    if (ps.shop.level >= this.gd.maxShopLevel) return fail(ERR.MAX_LEVEL);
    ps.shop.level++;
    ps.shop.upgradePrice = this.gd.upgradeBase(ps.shop.level) ?? 0;
    ps._openLevelSlots();
    this.tickerFor('SHOP_LEVEL', [ps.name, String(ps.shop.level)], { playerId: ps.playerId, param: String(ps.shop.level) });
    this.dispatch(ps, 'onLevelUp', { level: ps.shop.level, price: 0 });
    ps.dirty();
    return OK;
  }

  /** lp.set: the player's LP in a prep; while the team LP exists (the boss rounds) the team's, shared out as usual. */
  _debugSetLp(ps, value) {
    if (this.teamLp != null) {
      if (this.phase !== PHASE.PREP && this.phase !== PHASE.FINAL_ASSAULT && this.phase !== PHASE.HIDDEN_CORE) return fail(ERR.WRONG_PHASE);
      if (this._finalEnding) return fail(ERR.WRONG_PHASE, 'the leader battle is ending');
      this.teamLp = value;
      this._syncTeamLp();
      this._broadcastPool(true);
      this.markPublic();
      return OK;
    }
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE, 'in a prep only');
    ps.lp = value;
    ps.dirty();
    this.markPublic();
    return OK;
  }

  /** 取用: `count` copies into the hand (overflow temp), holding no shared-pool copy; HAND_FULL when none fit. */
  _debugGrant(ps, kind, id, count) {
    if (kind === 'chess') {
      const rec = ps.gd.chess(id);
      // a 自选 slot is only ever the player's own pick (an empty slot has no body)
      if (!rec || (rec.isDiy && !rec.diyFor)) return fail(ERR.BAD_TARGET, 'unknown chess');
    } else if (!ps.gd.item(id)) return fail(ERR.BAD_TARGET, 'unknown item');
    let got = 0;
    for (let i = 0; i < count; i++) {
      const piece = kind === 'chess' ? ps.acquireChess(id, { source: 'debug', fromPool: false }) : ps.acquireItem(id, { source: 'debug' });
      if (!piece) break;
      got++;
    }
    return got ? OK : fail(ERR.HAND_FULL);
  }

  /**
   * speed.set: the battle speed (game s per real s). A running battle continues where it is: every field clock is rebased
   * (`startAt`, the boss clock's start) so its elapsed game time does not jump, the HUD deadline / overtime moment and the
   * result deadlines / release timers follow the new pace; the browsers' runners rebase theirs on m.public.debug.speed.
   */
  _debugSetSpeed(v) {
    const old = this.gameSpeed;
    if (!(v > 0) || v === old) return;
    const battle = BATTLE_PHASES.has(this.phase);
    if (battle) {
      const now = this._clockNow();
      const rebase = (startAt) => now - ((now - startAt) * old) / v;
      const rest = (at) => (at > now ? Math.round(now + ((at - now) * old) / v) : at);
      for (const f of this.fields) if (f.cc && !f.done) f.startAt = rebase(f.startAt);
      if (this._bossStartAt != null) this._bossStartAt = rebase(this._bossStartAt);
      if (this.deadline) this.deadline = rest(this.deadline);
      if (this.overtimeAt) this.overtimeAt = rest(this.overtimeAt);
    }
    this.gameSpeed = v;
    if (battle && !this.paused) {
      for (const f of this.fields) {
        if (!f.cc || f.done) continue;
        if (f.deadlineTimer) this._armDeadline(f);
        if (f.doneTimer) this._armRelease(f);
      }
    }
    this.markPublic();
  }

  /**
   * prep.freeze: the prep countdown stops (on) — what was left of it is kept — or runs on (off): the rest of the frozen
   * prep, or the whole prep time of one that started frozen. Untimed preps (one human) stay untimed.
   */
  _debugFreezePrep(on) {
    const d = this.debug;
    if (d.freezePrep === on) return;
    d.freezePrep = on;
    if (this.phase === PHASE.PREP) {
      if (on) {
        d.frozenLeft = this.deadline ? Math.max(0, this.deadline - this.sched.now()) : null;
        d.frozenRound = this.round;
        this.setDeadline(0);
      } else {
        const full = this.soloUntimed ? null : this.gd.prepTime(this.round);
        const ms = d.frozenRound === this.round && Number.isFinite(d.frozenLeft) ? d.frozenLeft : full > 0 ? this.scaled(full * 1000) : 0;
        d.frozenLeft = null;
        d.frozenRound = null;
        if (ms > 0) {
          this.cancel(this._phaseTimer);
          this.deadline = this.sched.now() + ms;
          this._phaseTimer = this.later(ms, () => { this._phaseTimer = null; this.prepDeadline(); });
        }
      }
    }
    this.markPublic();
  }

  /** A prep that starts while the countdown is frozen: untimed until unfrozen (prep.js enterPrep). */
  _debugPrepFrozen() {
    if (!this.debug || !this.debug.freezePrep) return false;
    this.debug.frozenLeft = null;
    this.debug.frozenRound = this.round;
    return true;
  }

  /** round.jump n: from a prep — it ends (its 休整期结束时 effects, the temp resolved), no battle, round n starts. */
  _debugJump(n) {
    if (this.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE, 'from a prep only');
    if (n > this.gd.bossRound) return fail(ERR.BAD_TARGET, `the last round is ${this.gd.bossRound}`);
    this.debug.jumpTo = n;
    for (const ps of this.alivePlayers()) {
      if (ps.ready) continue;
      ps.resolveTemp();
      ps.ready = true;
      ps.dirty();
    }
    this.endPrep();
    return OK;
  }

  /** prep.js endPrep, after the players' endPrep: a requested jump starts its round now (true), else nothing (false). */
  _debugJumpNow() {
    if (!this.debug || this.debug.jumpTo == null) return false;
    const n = this.debug.jumpTo;
    this.debug.jumpTo = null;
    this.lastResults = new Map();
    this.startRound(n);
    return true;
  }

  /** battle.end (header): the running battle phase ends now. */
  _debugEndBattle(mode) {
    const boss = this.phase === PHASE.FINAL_ASSAULT || this.phase === PHASE.HIDDEN_CORE;
    const normal = this.phase === PHASE.COMBAT || this.phase === PHASE.UNITE;
    if (!boss && !normal) return fail(ERR.WRONG_PHASE, 'no battle running');
    const bossMode = mode === 'win' || mode === 'lose';
    if (boss !== bossMode) return fail(ERR.BAD_TARGET, boss ? 'a leader battle ends with win / lose' : 'a battle ends with natural / leak / kill');
    if (boss) return this._debugEndBoss(mode);
    const live = this.fields.filter((f) => (f.cc ? !f.done : f.live));
    if (!live.length) return fail(ERR.WRONG_PHASE, 'no battle running');
    if (this.clientCombat && live.every((f) => f.cc)) {
      for (const f of live) this._debugCutField(f, mode);
      return OK;
    }
    // server-run combat (SP_COMBAT=server): the FieldRunner's battles are the fields themselves
    if (!this.runner) return fail(ERR.WRONG_PHASE, 'no battle running');
    if (mode === 'natural') {
      for (const f of live) {
        const b = f.battle;
        try {
          while (!b.finished && b.time < HARD_CAP_SECONDS) b.step();
        } catch (e) {
          this.reportError(`debug ${f.fieldId} step`, e);
        }
      }
      this.runner.forceAll('timeout');
    } else {
      this.runner.forceAll(mode === 'leak' ? 'timeout' : 'forced');
    }
    return OK;
  }

  /**
   * One client-combat field ends now: `natural` — the battle's own result (a server-run field keeps the result it has),
   * `leak` / `kill` — the spec re-simulated up to the field clock, then ended as a timeout (the enemies on the field
   * leaked) or forced (nothing more counted). Its browsers are told (b.end), the field is done.
   */
  _debugCutField(f, mode) {
    let battle = null;
    let res = null;
    try {
      if (mode === 'natural' && f.mode === 'server' && f.result) {
        battle = f.battle;
        res = f.result;
      } else if (mode === 'natural') {
        const run = runHeadless(this._specBattle(f.spec), { players: f.players });
        battle = run.battle;
        res = run.result;
      } else {
        battle = this._specBattle(f.spec);
        const cap = Math.ceil(this._fieldElapsed(f) / TICK - 1e-9);
        while (!battle.finished && battle.tickCount < cap) battle.step();
        if (!battle.finished) battle.forceEnd(mode === 'leak' ? 'timeout' : 'forced');
        res = battle.result();
      }
    } catch (e) {
      this.reportError(`debug ${f.fieldId} end`, e);
    }
    this._clearFieldTimers(f);
    const shown = this._humansShowing(f);
    f.mode = 'server';
    f.authority = null;
    if (battle) f.battle = battle;
    f.result = res && res.perPlayer ? res : syntheticResult(f.players, { bossBy: f.bossBy, time: this._fieldElapsed(f) });
    f.resultSource = 'server';
    f.endGt = Number(battle && battle.time) || 0;
    // the authority stops reporting; a cut battle ends in every browser showing it as it ended here
    const reason = mode === 'natural' ? 'takeover' : mode === 'leak' ? 'timeout' : 'forced';
    for (const pid of shown) this.sendTo(pid, { t: 'b.end', battleId: f.battleId, fieldId: f.fieldId, reason });
    this._fieldDone(f);
  }

  /** battle.end in a boss round: `win` empties the leader's pool, `lose` the team LP (the lock does not hold it). */
  _debugEndBoss(mode) {
    if (this._finalEnding || !this.fields.some((f) => (f.cc ? !f.done : f.live))) return fail(ERR.WRONG_PHASE, 'the leader battle is ending');
    if (mode === 'win') {
      if (this.bossPool && this.bossPool.hp > 0) this.bossPool.damage(null, this.bossPool.hp);
    } else {
      this.teamLp = 0;
      this._syncTeamLp();
    }
    // server-run boss fields (FieldRunner): an empty pool ends them as cleared at their next step; a defeat forces them
    if (this.runner) {
      if (mode === 'lose') this.runner.forceAll('forced');
    } else {
      this._checkFinalEnd();
    }
    this.markPublic();
    return OK;
  }
}
