// ui/debugPanel.js — the in-match panel of a debug match (DESIGN §27): opened from the DEBUG button of the bottom-left
// corner, three tabs —
//   状态  funds, 调度中心 level, LP (the team LP in a leader battle), the LP lock, bond layers — of oneself, or (the host)
//         of any player still in, AI seats included;
//   时间  the battle speed (1× / 2× / 4×), the pause, the frozen prep countdown, ending the running battle, jumping to a
//         round / the Final Assault — the host's;
//   取用  operators (normal / ×3 / elite; one's own 自选 picks too) and items into the target's 整备区.
// Every button sends g.debug (ui/gameActions.js actions.debug); the server decides and the views follow its pushes —
// what the viewer may not use now is greyed out with the reason (ui/gameLogic/debug.js debugOpState).

import { useMemo, useState } from '../../vendor/hooks.module.js';
import { PHASE } from '../../../shared/constants.js';
import { DEBUG_LIMITS, DEBUG_SPEEDS } from '../../../shared/debug.js';
import { html, Button, Icon, MicroLabel, Tabs } from './components.js';
import { UnitThumb } from './gameComponents.js';
import { actions } from './gameActions.js';
import { debugEndModes, debugOpState, debugWhyText, debugTargets, debugCatalog, diyPicks, ownDiyRecord } from './gameLogic.js';
import { PROF_ORDER, PROF_NAME } from './loadoutModel.js';
import { data } from '../data.js';
import { t, tc } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const END_LABEL = {
  natural: () => t('快进到战斗结束'), leak: () => t('立即结束（剩余敌人算漏怪）'), kill: () => t('立即结束（剩余敌人不计）'),
  win: () => t('判定胜利（领袖被击败）'), lose: () => t('判定失败（全队生命值归零）'),
};
const BATTLE = new Set([PHASE.COMBAT, PHASE.UNITE, PHASE.FINAL_ASSAULT, PHASE.HIDDEN_CORE]);

function Row({ label, children, note }) {
  return html`<div class="dbgp-row">
    <span class="dbgp-row__label">${label}</span>
    <div class="dbgp-row__ctl">${children}</div>
    ${note ? html`<span class="dbgp-row__note">${note}</span>` : null}
  </div>`;
}

/** An integer input whose value is sent by its button (Enter sends too). */
function NumSend({ min, max, placeholder, label, disabled, onSend }) {
  const [v, setV] = useState('');
  const send = () => {
    const n = Math.trunc(Number(String(v).trim()));
    if (!String(v).trim() || !Number.isFinite(n)) return;
    onSend(Math.max(min, Math.min(max, n)));
  };
  return html`<span class="dbgp-num">
    <input class="dbg-num num" type="number" inputmode="numeric" step="1" min=${min} max=${max} value=${v} placeholder=${placeholder}
      aria-label=${label} disabled=${disabled} onInput=${(e) => setV(e.currentTarget.value)}
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
    <${Button} size="sm" variant="amber" disabled=${disabled} onClick=${send}>${t('设定')}<//>
  </span>`;
}

/**
 * The panel. `room` (room.state) names the host; `gd` the game data lookups (ui/gameComponents.js useGameData).
 * @param {{ pub: any, priv: any, myId: string|null, isHost: boolean, gd: any, onClose: () => void }} props
 */
export function DebugPanel({ pub, priv, myId, isHost, gd, onClose }) {
  const [tab, setTab] = useState('state');
  const [targetId, setTargetId] = useState(myId);
  const targets = debugTargets(pub, myId, isHost);
  const target = targets.find((p) => p.playerId === targetId) || targets.find((p) => p.self) || targets[0] || null;
  const tp = Array.isArray(pub?.players) ? pub.players.find((p) => p && p.playerId === target?.playerId) : null;
  const self = !!target?.self;
  const phase = pub?.phase ?? null;
  const dbg = pub?.debug || {};
  const teamLp = Number.isFinite(pub?.teamLp);
  const ctx = { phase, isHost, self, alive: target?.alive !== false, teamLp };
  const state = (op) => debugOpState(op, ctx);
  const send = (op, fields = {}) => {
    const s = state(op);
    if (!s.ok) return Promise.resolve(false);
    const targeted = ['funds.set', 'funds.add', 'level.set', 'level.up', 'lp.set', 'layers.set', 'layers.add', 'chess.grant', 'item.grant'].includes(op);
    return actions.debug(op, targeted && target && !self ? { ...fields, target: target.playerId } : fields);
  };
  const why = (op) => { const s = state(op); return s.ok ? null : debugWhyText(s.why); };

  const tabs = [{ id: 'state', label: t('状态') }, { id: 'time', label: t('时间') }, { id: 'take', label: t('取用') }];
  // the panel owns the keyboard while it has the focus: typed numbers and names never reach the match's shortcuts
  return html`<aside class="dbgp brackets" role="dialog" aria-label=${t('调试面板')} data-testid="debug-panel"
      onKeyDown=${(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}>
    <header class="dbgp__head">
      <span class="dbgp__title"><${Icon} name="warn" />${t('调试面板')}<${MicroLabel}>DEBUG<//></span>
      <button type="button" class="dbgp__close" aria-label=${t('关闭')} title=${t('关闭')} onClick=${onClose}><${Icon} name="close" /></button>
    </header>
    ${isHost && targets.length > 1 ? html`<div class="dbgp__targets" role="radiogroup" aria-label=${t('操作对象')}>
      ${targets.map((p) => html`<button key=${p.playerId} type="button" role="radio" aria-checked=${p.playerId === target?.playerId ? 'true' : 'false'}
        class=${cx('dbg-chip', p.playerId === target?.playerId && 'is-on', !p.alive && 'is-off')} onClick=${() => setTargetId(p.playerId)}>
        ${p.isBot ? html`<${Icon} name="robot" />` : null}${p.self ? t('你') : p.name}</button>`)}
    </div>` : null}
    <${Tabs} items=${tabs} value=${tab} onChange=${setTab} size="sm" class="dbgp__tabs" />
    <div class="dbgp__body">
      ${tab === 'state' ? html`<${StateTab} pub=${pub} priv=${priv} tp=${tp} self=${self} dbg=${dbg} teamLp=${teamLp} gd=${gd} send=${send} why=${why} />` : null}
      ${tab === 'time' ? html`<${TimeTab} pub=${pub} dbg=${dbg} send=${send} why=${why} isHost=${isHost} />` : null}
      ${tab === 'take' ? html`<${TakeTab} priv=${self ? priv : null} gd=${gd} send=${send} why=${why} />` : null}
    </div>
  </aside>`;
}

function StateTab({ pub, priv, tp, self, dbg, teamLp, gd, send, why }) {
  const [bondId, setBondId] = useState('');
  const maxLevel = Number(gd.config?.modes?.[pub?.modeId]?.maxShopLevel) || 6;
  const level = Number.isFinite(tp?.shopLevel) ? tp.shopLevel : null;
  const lp = teamLp ? pub.teamLp : Number.isFinite(tp?.lp) ? tp.lp : null;
  const funds = self && Number.isFinite(priv?.funds) ? priv.funds : null;
  const bondIds = useMemo(() => Object.keys(data.get('bonds') || {}), [data.get('bonds')]);
  const layersOf = (id) => (Array.isArray(tp?.bonds) ? tp.bonds.find((b) => b && b.bondId === id)?.layers ?? 0 : 0);
  const bid = bondId || bondIds[0] || '';
  return html`
    <${Row} label=${t('资金')} note=${why('funds.set') || (funds != null ? t('当前 {n}', { n: funds }) : null)}>
      <${NumSend} min=${0} max=${DEBUG_LIMITS.funds} placeholder="0–999" label=${t('资金')} disabled=${!!why('funds.set')} onSend=${(v) => send('funds.set', { value: v })} />
      <${Button} size="sm" disabled=${!!why('funds.add')} onClick=${() => send('funds.add', { value: 10 })}>+10<//>
      <${Button} size="sm" disabled=${!!why('funds.add')} onClick=${() => send('funds.add', { value: 50 })}>+50<//>
    <//>
    <${Row} label=${t('调度中心')} note=${why('level.set') || (level != null ? t('当前 {n} 级', { n: level }) : null)}>
      <div class="dbg-chips">
        ${Array.from({ length: maxLevel }, (_, i) => i + 1).map((n) => html`<button key=${n} type="button" class=${cx('dbg-chip', level === n && 'is-on')}
          disabled=${!!why('level.set')} title=${t('直接设定为 {n} 级（不触发升级效果）', { n })} onClick=${() => send('level.set', { value: n })}>${n}</button>`)}
      </div>
      <${Button} size="sm" variant="amber" icon="plus" disabled=${!!why('level.up') || (level != null && level >= maxLevel)}
        title=${t('升一级：和正常升级一样触发效果，但不花费资金')} onClick=${() => send('level.up')}>${t('升一级')}<//>
    <//>
    <${Row} label=${teamLp ? t('全队生命值') : t('生命值')} note=${why('lp.set') || (lp != null ? t('当前 {n}', { n: lp }) : null)}>
      <${NumSend} min=${1} max=${DEBUG_LIMITS.lp} placeholder="1–999" label=${t('生命值')} disabled=${!!why('lp.set')} onSend=${(v) => send('lp.set', { value: v })} />
    <//>
    <${Row} label=${t('锁血')} note=${why('lp.lock') || t('开启后生命值不会降到 0，不会被淘汰')}>
      <div class="dbg-chips">
        <button type="button" class=${cx('dbg-chip', !dbg.lockLp && 'is-on')} disabled=${!!why('lp.lock')} onClick=${() => send('lp.lock', { on: false })}>${tc('toggle', '关闭')}</button>
        <button type="button" class=${cx('dbg-chip', !!dbg.lockLp && 'is-on')} disabled=${!!why('lp.lock')} onClick=${() => send('lp.lock', { on: true })}>${tc('toggle', '开启')}</button>
      </div>
    <//>
    <${Row} label=${t('盟约层数')} note=${why('layers.set') || (bid ? t('当前 {n} 层', { n: layersOf(bid) }) : null)}>
      <select class="dbg-select" value=${bid} aria-label=${t('盟约')} onChange=${(e) => setBondId(e.currentTarget.value)}>
        ${bondIds.map((id) => html`<option key=${id} value=${id}>${gd.bond(id)?.name || id}</option>`)}
      </select>
      <${NumSend} min=${0} max=${DEBUG_LIMITS.layers} placeholder="0–999" label=${t('盟约层数')} disabled=${!bid || !!why('layers.set')}
        onSend=${(v) => send('layers.set', { id: bid, value: v })} />
      <${Button} size="sm" disabled=${!bid || !!why('layers.add')} title=${t('增加层数：和正常获得一样触发效果')}
        onClick=${() => send('layers.add', { id: bid, value: 10 })}>+10<//>
    <//>`;
}

function TimeTab({ pub, dbg, send, why: whyOf, isHost }) {
  const phase = pub?.phase;
  const modes = debugEndModes(phase);
  const bossRound = Number.isFinite(pub?.bossRound) ? pub.bossRound : 14;
  const battle = BATTLE.has(phase);
  // every control here is the host's: another player reads that once, at the top, and the rows keep their hints
  const why = (op) => (isHost ? whyOf(op) : null);
  const off = (op) => !isHost || !!whyOf(op);
  return html`
    ${isHost ? null : html`<p class="dbg-note"><${Icon} name="info" />${t('时间控制只有房主可以使用')}</p>`}
    <${Row} label=${t('作战速度')} note=${why('speed.set') || t('只改变播放快慢，不影响作战结果')}>
      <div class="dbg-chips">
        ${DEBUG_SPEEDS.map((v) => html`<button key=${v} type="button" class=${cx('dbg-chip', (dbg.speed ?? 2) === v && 'is-on')}
          disabled=${off('speed.set')} onClick=${() => send('speed.set', { value: v })}>${v}×</button>`)}
      </div>
    <//>
    <${Row} label=${t('暂停')} note=${isHost && !battle && !pub?.paused ? debugWhyText('battle') : null}>
      <${Button} size="sm" variant="amber" icon=${pub?.paused ? 'play' : 'hourglass'} disabled=${!isHost || (!battle && !pub?.paused)}
        onClick=${() => actions.pause(!pub?.paused)}>${pub?.paused ? t('继续作战') : t('暂停作战')}<//>
    <//>
    <${Row} label=${t('休整期倒计时')} note=${why('prep.freeze') || t('冻结后休整期不再计时，所有博士准备就绪后才进入作战')}>
      <div class="dbg-chips">
        <button type="button" class=${cx('dbg-chip', !dbg.freezePrep && 'is-on')} disabled=${off('prep.freeze')} onClick=${() => send('prep.freeze', { on: false })}>${t('正常计时')}</button>
        <button type="button" class=${cx('dbg-chip', !!dbg.freezePrep && 'is-on')} disabled=${off('prep.freeze')} onClick=${() => send('prep.freeze', { on: true })}>${t('冻结')}</button>
      </div>
    <//>
    <${Row} label=${t('结束本场战斗')} note=${why('battle.end')}>
      <div class="dbgp-col">
        ${(modes.length ? modes : ['natural', 'leak', 'kill']).map((mode) => html`<${Button} key=${mode} size="sm" variant=${mode === 'lose' ? 'danger' : 'secondary'}
          disabled=${off('battle.end')} onClick=${() => send('battle.end', { mode })}>${END_LABEL[mode]()}<//>`)}
      </div>
    <//>
    <${Row} label=${t('跳到回合')} note=${why('round.jump') || t('结束本休整期（不进行作战），直接开始该回合')}>
      <${NumSend} min=${1} max=${bossRound} placeholder=${`1–${bossRound}`} label=${t('跳到回合')} disabled=${off('round.jump')}
        onSend=${(v) => send('round.jump', { value: v })} />
      <${Button} size="sm" variant="amber" icon="chevrons" disabled=${off('round.jump')} onClick=${() => send('round.jump', { value: bossRound })}>${t('进入最终攻势')}<//>
    <//>`;
}

const TIERS = [1, 2, 3, 4, 5, 6];

function TakeTab({ priv, gd, send, why }) {
  const [kind, setKind] = useState('chess');
  const [query, setQuery] = useState('');
  const [tier, setTier] = useState(null);
  const [prof, setProf] = useState(null);
  const [bond, setBond] = useState('');
  const chessRecs = data.get('chess');
  const itemRecs = data.get('items');
  const list = useMemo(() => debugCatalog(Object.values((kind === 'chess' ? chessRecs : itemRecs) || {}), { kind, query, tier, prof, bond: bond || null }),
    [kind, query, tier, prof, bond, chessRecs, itemRecs]);
  // the target's own 自选 picks (only oneself: another player's picks are not in this view)
  const diy = kind === 'chess' && priv ? Object.keys(diyPicks(priv)).map((slot) => {
    const rec = ownDiyRecord(gd.chess(slot), priv, { chess: data.get('chess'), backups: data.get('backups') });
    return rec ? { id: slot, goldenId: gd.chess(slot)?.goldenId || null, name: rec.name || slot, tier: rec.tier, rec } : null;
  }).filter(Boolean) : [];
  const blocked = why(kind === 'chess' ? 'chess.grant' : 'item.grant');
  const grant = (id, value) => send(kind === 'chess' ? 'chess.grant' : 'item.grant', value > 1 ? { id, value } : { id });
  const bondIds = Object.keys(data.get('bonds') || {});
  const row = (e) => html`<li key=${e.id} class=${cx('dbgp-item', e.special && 'is-special')}>
    <${UnitThumb} kind=${kind === 'chess' ? 'chess' : 'item'} id=${e.id} size="sm" rec=${e.rec || null} />
    <span class="dbgp-item__name">${e.name}${e.special ? html`<small>${t('特殊')}</small>` : null}${e.golden ? html`<small>${t('精锐')}</small>` : null}</span>
    <span class="dbgp-item__btns">
      <${Button} size="sm" disabled=${!!blocked} onClick=${() => grant(e.id, 1)}>+1<//>
      ${kind === 'chess' ? html`<${Button} size="sm" disabled=${!!blocked} title=${t('一次取用 3 名：凑满后自动晋升精锐')} onClick=${() => grant(e.id, 3)}>×3<//>
        ${e.goldenId ? html`<${Button} size="sm" variant="amber" disabled=${!!blocked} onClick=${() => grant(e.goldenId, 1)}>${t('精锐')}<//>` : null}` : null}
    </span>
  </li>`;
  return html`
    ${blocked ? html`<p class="dbg-note"><${Icon} name="info" />${blocked}</p>` : null}
    <div class="dbgp-take__bar">
      <div class="dbg-chips">
        <button type="button" class=${cx('dbg-chip', kind === 'chess' && 'is-on')} onClick=${() => setKind('chess')}>${t('干员')}</button>
        <button type="button" class=${cx('dbg-chip', kind === 'item' && 'is-on')} onClick=${() => setKind('item')}>${t('道具')}</button>
      </div>
      <input class="dbgp-search" type="search" value=${query} placeholder=${t('搜索名称')} aria-label=${t('搜索名称')}
        onInput=${(e) => setQuery(e.currentTarget.value)} />
    </div>
    <div class="dbg-chips">
      <button type="button" class=${cx('dbg-chip', tier == null && 'is-on')} onClick=${() => setTier(null)}>${t('全部')}</button>
      ${TIERS.map((n) => html`<button key=${n} type="button" class=${cx('dbg-chip', tier === n && 'is-on')} onClick=${() => setTier(tier === n ? null : n)}>${t('{tier}阶', { tier: n })}</button>`)}
    </div>
    ${kind === 'chess' ? html`<div class="dbg-chips">
      ${PROF_ORDER.map((p) => html`<button key=${p} type="button" class=${cx('dbg-chip', prof === p && 'is-on')} onClick=${() => setProf(prof === p ? null : p)}>${t(PROF_NAME[p])}</button>`)}
      <select class="dbg-select" value=${bond} aria-label=${t('盟约')} onChange=${(e) => setBond(e.currentTarget.value)}>
        <option value="">${t('全部盟约')}</option>
        ${bondIds.map((id) => html`<option key=${id} value=${id}>${gd.bond(id)?.name || id}</option>`)}
      </select>
    </div>` : null}
    ${diy.length ? html`<h4 class="dbgp-take__sub">${t('自选干员')}</h4><ul class="dbgp-list">${diy.map(row)}</ul>` : null}
    <ul class="dbgp-list">${list.length ? list.map(row) : html`<li class="t-dim dbgp-empty">${t('没有符合条件的结果')}</li>`}</ul>`;
}
