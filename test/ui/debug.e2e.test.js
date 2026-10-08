// Real-server browser E2E — debug rooms (DESIGN §27, a remake tool for testing). The host turns on 设置 → 调试模式 from
// the lobby's gear, types DBUG into 加入同盟 and confirms 「你即将进入 DEBUG Mode 房间」: a debug room with an ordinary key,
// the DEBUG mark and the settings bar; the settings dialog sets a battlefield, a leader, custom bans, an enemy type and
// the start round / level; a friend without the switch joins by the key after the same confirmation and sees the
// settings read-only. In the match: the DEBUG mark, the DBG panel — 状态 (funds), 取用 (an elite into the 整备区),
// 时间 (4×, the host's pause of a co-op battle, ending it, 进入最终攻势) — the friend's panel without the host's tools,
// and the result screen's DEBUG mark. No art needed (missing images are not counted as problems).
// Node side: test/ui/debug.test.js; server side: test/lobby-debug.test.js, test/match/debug.test.js.
//
//   SP_E2E=1 CHROME_PATH=/path/to/chrome node --test test/ui/debug.e2e.test.js
//
// Screenshots: test/e2e/out/debug-*.png.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Client, sleep, hasChrome, startRealServer } from '../e2e/client.mjs';

const ENABLED = process.env.SP_E2E === '1' && hasChrome();
/** Missing art (not downloaded) and the web fonts (offline) are fine here: the debug tools need neither. */
const realProblems = (c) => c.problems.filter((p) => !/\/assets\/|\/fonts\/|\/media\/|\/vendor\/|http 404|fonts\.(googleapis|gstatic)\.com/.test(p));

const st = (c) => c.page.evaluate(() => {
  const s = globalThis.__SP__.store.get();
  const p = s.match.public;
  return {
    phase: p?.phase ?? null, round: p?.round ?? 0, paused: !!p?.paused, debug: p?.debug ?? null, teamLp: p?.teamLp ?? null,
    funds: s.match.private?.funds ?? null, hand: (s.match.private?.hand || []).filter(Boolean).map((x) => x.id),
    battle: s.match.battle ? { speed: s.match.battle.speed } : null, result: !!s.match.result, room: s.room,
  };
});
const BANDS = ['band_amiya', 'band_kalts', 'band_bldsk', 'band_duyaoy'];
const req = (c, t, f = {}) => c.page.evaluate((t, f) => globalThis.__SP__.net.request(t, f).then(() => 'ok', (e) => e.code || 'ERR'), t, f);
async function until(c, pred, what, timeout = 60000) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    last = await st(c);
    if (pred(last)) return last;
    await sleep(200);
  }
  throw new Error(`${c.label}: timed out waiting for ${what} (${JSON.stringify({ ...last, room: undefined })})`);
}
/** Answer the draft and the 机变 turns by request until the round's prep. */
async function toPrep(clients, round) {
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) {
    const s = await st(clients[0]);
    if (s.phase === 'PREP' && s.round === round) return;
    for (const [i, c] of clients.entries()) {
      if (s.phase === 'INFO_CHECK') await req(c, 'g.infoReady');
      if (s.phase === 'BAND_DRAFT') for (const bandId of [...BANDS.slice(i), ...BANDS.slice(0, i)]) if ((await req(c, 'g.band', { bandId })) === 'ok') break;
      if (s.phase === 'SP_DRAFT') for (let k = 0; k < 6; k++) await req(c, 'g.choice', { idx: k });
    }
    await sleep(300);
  }
  throw new Error(`no PREP R${round}`);
}
const typeInto = async (c, sel, text) => {
  await c.page.click(sel, { clickCount: 3 });
  await c.page.type(sel, String(text));
  await c.page.keyboard.press('Enter');
};

describe('debug rooms (DESIGN §27, real server)', { skip: !ENABLED && 'set SP_E2E=1 and CHROME_PATH' }, () => {
  test('DBUG → confirm → settings → a friend joins → the DBG panel → speed, pause, end, Final Assault → result', { timeout: 6 * 60 * 1000 }, async () => {
    const srv = await startRealServer();
    const P = (await import('puppeteer-core')).default;
    const host = new Client(P, srv.base, 'host', { prefix: 'debug', w: 1600, h: 900 });
    const friend = new Client(P, srv.base, 'friend', { prefix: 'debug', w: 1600, h: 900 });
    try {
      // ---- the way in: the switch from the lobby's gear, DBUG, the confirmation
      await host.open();
      await host.enter('Host');
      await host.click('.join-row input');
      await host.page.keyboard.type('DBUG');
      await host.click('.join-row button', '加入同盟');
      await host.page.waitForSelector('.toast__text', { timeout: 5000 });
      assert.match(await host.page.$eval('.toast__text', (e) => e.textContent), /请先在「设置」中开启调试模式/);
      await host.click('.lobby-settings');
      await host.page.evaluate(() => {
        const row = [...document.querySelectorAll('.set-row')].find((r) => r.textContent.includes('调试模式'));
        row.querySelector('button[role="switch"]').click();
      });
      await sleep(200);
      assert.equal(await host.page.evaluate(() => localStorage.getItem('sp.pref.debugMode')), 'true');
      await host.page.keyboard.press('Escape');
      await sleep(300);
      await host.click('.join-row button', '加入同盟');
      await host.page.waitForSelector('.modal__box--amber', { timeout: 5000 });
      assert.match(await host.page.$eval('.modal__box--amber', (e) => e.textContent), /你即将进入 DEBUG Mode 房间/);
      await host.shot('confirm');
      await host.click('.modal__actions button', '进入');
      await host.page.waitForSelector('.room-screen [data-testid="debug-badge"]', { timeout: 10000 });
      const code = (await st(host)).room.code;
      assert.notEqual(code, 'DBUG');
      await host.click('.room-bar button, .seat button', '添加 AI 队友');

      // ---- the settings dialog
      await host.click('[data-testid="debug-bar"] button', '修改');
      await host.page.waitForSelector('.dbg-modal', { timeout: 5000 });
      await host.click('.dbg-chip', '战场#03');
      const pick = async (text) => {
        await host.page.evaluate((text) => [...document.querySelectorAll('.dbg-chip')].find((e) => e.textContent.trim() === text)?.scrollIntoView({ block: 'center' }), text);
        await sleep(100);
        await host.page.evaluate((text) => [...document.querySelectorAll('.dbg-chip')].find((e) => e.textContent.trim() === text)?.click(), text);
        await sleep(100);
      };
      await pick('自定义');
      await pick('飞行');
      for (let i = 0; i < 2; i++) {
        await host.page.evaluate(() => document.querySelector('.dbg-step button[aria-label="增加"]').click());
        await sleep(150);
      }
      await pick('4');
      await host.shot('settings');
      await host.click('.modal__actions button', '应用设置');
      await host.page.waitForSelector('.modal__box', { hidden: true, timeout: 5000 });
      const cfg = (await st(host)).room.debugConfig;
      assert.equal(cfg.stageId, 'act1autochess_m03');
      assert.deepEqual(cfg.factions, ['FLY']);
      assert.deepEqual([cfg.bans.mode, cfg.start.round, cfg.start.level], ['custom', 3, 4]);
      const chips = await host.page.$$eval('.dbg-bar__chip', (els) => els.map((e) => e.textContent));
      assert.ok(chips.some((x) => /从第 3 回合开始/.test(x)) && chips.some((x) => /调度中心 4 级/.test(x)), chips.join(' | '));
      await host.shot('room');

      // ---- a friend without the switch joins by the key: the same confirmation, the settings read-only
      await friend.open();
      await friend.enter('Friend');
      await friend.click('.join-row input');
      await friend.page.keyboard.type(code);
      await friend.click('.join-row button', '加入同盟');
      await friend.page.waitForSelector('.modal__box--amber', { timeout: 5000 });
      await friend.click('.modal__actions button', '进入');
      await friend.page.waitForSelector('.room-screen [data-testid="debug-bar"]', { timeout: 10000 });
      assert.match(await friend.page.$eval('[data-testid="debug-bar"] button', (e) => e.textContent), /查看/);
      await friend.click('.room-bar button', '准备就绪');
      await sleep(400);

      // ---- the match: round 3 at level 4
      await host.click('.room-bar button', '开始模拟');
      await until(host, (s) => s.phase === 'INFO_CHECK', 'the briefing');
      await toPrep([host, friend], 3);
      let s = await until(host, (x) => x.phase === 'PREP' && x.round === 3, 'PREP R3');
      assert.deepEqual([s.debug.startRound, s.debug.speed], [3, 2]);
      await host.page.waitForSelector('.gtop__debug', { timeout: 5000 });

      // 状态 / 取用 / 时间 (the host)
      await host.click('[data-testid="debug-toggle"]');
      await host.page.waitForSelector('[data-testid="debug-panel"]');
      await typeInto(host, '.dbgp input.dbg-num[aria-label="资金"]', 77);
      await until(host, (x) => x.funds === 77, 'funds 77');
      await host.click('.dbgp .tabs__tab', '取用');
      await host.click('.dbgp-item .btn', '精锐');
      await until(host, (x) => x.hand.some((id) => /_b$/.test(id)), 'an elite in the 整备区');
      await host.shot('panel-take');
      await host.click('.dbgp .tabs__tab', '时间');
      await host.click('.dbgp .dbg-chip', '4×');
      await until(host, (x) => x.debug?.speed === 4, 'speed 4');
      await host.shot('panel-time');

      // the friend's panel: own state only, no time tools
      await friend.click('[data-testid="debug-toggle"]');
      await friend.page.waitForSelector('[data-testid="debug-panel"]');
      assert.equal(await friend.page.$('.dbgp__targets'), null, 'no other targets for a guest');
      await friend.click('.dbgp .tabs__tab', '时间');
      assert.match(await friend.page.$eval('.dbgp', (e) => e.textContent), /时间控制只有房主可以使用/);
      assert.equal(await friend.page.$eval('.dbgp .dbg-chip', (e) => e.disabled), true);
      assert.equal(await req(friend, 'g.debug', { op: 'speed.set', value: 1 }), 'NOT_HOST');

      // ---- a battle at 4×: the host's pause, then ending it
      await req(friend, 'g.ready', { ready: true });
      await host.click('.dbgp__close');
      await host.click('.readybtn');
      s = await until(host, (x) => x.phase === 'COMBAT' && x.battle, 'the battle');
      assert.equal(s.battle.speed, 4, 'the local battle runs at 4×');
      await host.click('[data-testid="debug-toggle"]');
      await host.click('.dbgp .tabs__tab', '时间');
      await host.click('.dbgp .btn', '暂停作战');
      await until(host, (x) => x.paused, 'paused');
      await host.shot('paused');
      await host.click('.dbgp .btn', '继续作战');
      await until(host, (x) => !x.paused, 'resumed');
      await host.click('.dbgp .btn', '剩余敌人不计');
      await until(host, (x) => x.phase !== 'COMBAT', 'the battle ended');

      // ---- 进入最终攻势, then 判定失败
      await toPrep([host, friend], 4);
      await host.click('.dbgp .tabs__tab', '时间');
      await host.click('.dbgp .btn', '进入最终攻势');
      await toPrep([host, friend], 14);
      await req(friend, 'g.ready', { ready: true });
      await req(host, 'g.ready', { ready: true });
      s = await until(host, (x) => x.phase === 'FINAL_ASSAULT', 'the Final Assault');
      assert.ok(s.teamLp > 0);
      await host.click('.dbgp .tabs__tab', '时间');
      await host.click('.dbgp .btn', '判定失败');
      await until(host, (x) => x.result, 'the result');
      await host.page.waitForSelector('.result__debug', { timeout: 10000 });
      await host.shot('result');
      assert.deepEqual(realProblems(host), []);
      assert.deepEqual(realProblems(friend), []);
    } finally {
      await host.close();
      await friend.close();
      await srv.stop();
    }
  });
});
