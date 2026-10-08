// ui/debugRoom.js — a debug room in the room screen (DESIGN §27): the DEBUG mark, the bar that sums up the room's
// settings (room.state `debugConfig`) and the settings dialog — the host edits a draft and sends it whole with
// room.debugConfig { config } (the server checks it leniently against the mode and broadcasts the result); everyone else
// sees the same dialog read-only. The lists come from shared/debug.js debugOptions over the static data, so the dialog
// offers exactly what the server accepts.

import { useEffect, useMemo, useRef, useState } from '../../vendor/hooks.module.js';
import { modeIdFor } from '../../../shared/constants.js';
import { DEBUG_LIMITS, debugOptions, defaultDebugConfig } from '../../../shared/debug.js';
import { html, Button, Icon, MicroLabel, Modal } from './components.js';
import { toast, toastError } from './toasts.js';
import { data, useData, getStage, getBoss, getBond, getBand } from '../data.js';
import { debugSummary, factionTypeName } from './gameLogic.js';
import { net } from '../net.js';
import { t, tc } from '../../../shared/i18n.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');
const FILES = ['config', 'stages', 'bosses', 'bonds', 'factions', 'bands'];

/** The DEBUG mark of a debug room / match. @param {{ size?: 'sm'|'md', class?: string }} props */
export function DebugBadge({ size = 'md', class: cls }) {
  return html`<span class=${cx('dbg-badge', `dbg-badge--${size}`, cls)} role="status" data-testid="debug-badge">
    <${Icon} name="warn" /><b>DEBUG</b><span>${t('运行中')}</span>
  </span>`;
}

/** The display names the bar and the dialog use. */
export function debugNames() {
  return {
    stage: (id) => getStage(id)?.name || id,
    boss: (id) => getBoss(id)?.name || id,
    bond: (id) => getBond(id)?.name || id,
    faction: (type) => factionTypeName(data.get('factions'), type),
    band: (id) => getBand(id)?.name || id,
  };
}

/** What the room's mode offers (shared/debug.js debugOptions over the loaded data). */
function useDebugOptions(room) {
  const ready = useData(...FILES);
  return useMemo(() => debugOptions({
    config: data.get('config'), stages: data.get('stages'), bosses: data.get('bosses'), bonds: data.get('bonds'),
    factions: data.get('factions'), bands: data.get('bands'),
  }, modeIdFor(room.mode, room.difficulty)), [ready, room.mode, room.difficulty, data.locale()]);
}

/**
 * The bar under the seats: the settings that differ from the official match (or 「全部按正式规则」) and the button that
 * opens the dialog (修改 for the host, 查看 for the others).
 * @param {{ room: any, isHost: boolean, onOpen: () => void }} props
 */
export function DebugRoomBar({ room, isHost, onOpen }) {
  useData(...FILES);
  const lines = debugSummary(room.debugConfig, debugNames());
  return html`<section class="dbg-bar brackets" aria-label=${t('调试设置')} data-testid="debug-bar">
    <span class="dbg-bar__label"><${Icon} name="warn" />${t('调试设置')}<${MicroLabel}>DEBUG SETUP<//></span>
    <span class="dbg-bar__list">
      ${lines.length ? lines.map((x) => html`<span key=${x} class="dbg-bar__chip">${x}</span>`) : html`<span class="t-dim">${t('全部按正式规则')}</span>`}
    </span>
    <${Button} size="sm" variant="amber" icon=${isHost ? 'edit' : 'eye'} onClick=${onOpen}>${isHost ? t('修改') : t('查看')}<//>
  </section>`;
}

/** A row of choice chips. `multi`: toggles; `value` is the picked id (or the set of ids). */
function Chips({ items, value, onPick, disabled = false, multi = false }) {
  const on = (id) => (multi ? value.includes(id) : value === id);
  return html`<div class="dbg-chips" role=${multi ? 'group' : 'radiogroup'}>
    ${items.map((it) => html`<button key=${String(it.id)} type="button" role=${multi ? 'checkbox' : 'radio'}
        aria-checked=${on(it.id) ? 'true' : 'false'} class=${cx('dbg-chip', on(it.id) && 'is-on', it.off && 'is-off')}
        disabled=${disabled || it.disabled} title=${it.title || null} onClick=${() => onPick(it.id)}>${it.label}</button>`)}
  </div>`;
}

/** An integer field (a string while typed; '' = no value). */
function NumField({ value, onInput, min, max, placeholder, disabled = false, label }) {
  return html`<input class="dbg-num num" type="number" inputmode="numeric" min=${min} max=${max} step="1" value=${value}
    placeholder=${placeholder} disabled=${disabled} aria-label=${label} onInput=${(e) => onInput(e.currentTarget.value)} />`;
}

/** '' → null, else an integer clamped into [lo, hi] (null when it is no number). */
export function parseIntField(s, lo, hi) {
  const v = String(s ?? '').trim();
  if (!v) return null;
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
}

const str = (v) => (Number.isInteger(v) ? String(v) : '');

/** The dialog's draft of a config: the number fields as strings. */
function draftOf(c) {
  const cfg = c || defaultDebugConfig();
  return {
    ...cfg, bans: { ...cfg.bans, bonds: [...cfg.bans.bonds] }, factions: cfg.factions ? [...cfg.factions] : null,
    start: { ...cfg.start }, bands: { ...cfg.bands },
    text: { seed: str(cfg.seed), funds: str(cfg.start.funds), lp: str(cfg.start.lp) },
  };
}

/** The config a draft sends (room.debugConfig.config). */
function wireOf(d, opt) {
  return {
    seed: parseIntField(d.text.seed, 0, DEBUG_LIMITS.seed),
    stageId: d.stageId, bossId: d.bossId, hiddenBossId: d.hiddenBossId, forceHidden: !!d.forceHidden,
    bans: { mode: d.bans.mode, bonds: d.bans.mode === 'custom' ? d.bans.bonds : [] },
    factions: d.factions && d.factions.length ? d.factions : null,
    start: {
      round: Math.max(1, Math.min(opt.bossRound, d.start.round || 1)),
      funds: parseIntField(d.text.funds, 0, DEBUG_LIMITS.funds), level: d.start.level ?? null,
      lp: parseIntField(d.text.lp, 1, DEBUG_LIMITS.lp), lockLp: !!d.start.lockLp,
    },
    bands: Object.fromEntries(Object.entries(d.bands).filter(([, id]) => typeof id === 'string' && id)),
  };
}

function Section({ title, micro, children, note }) {
  return html`<section class="dbg-sec">
    <h3 class="dbg-sec__title">${title}<${MicroLabel}>${micro}<//></h3>
    ${children}
    ${note ? html`<p class="dbg-note">${note}</p>` : null}
  </section>`;
}

function Row({ label, children, hint }) {
  return html`<div class="dbg-row">
    <span class="dbg-row__label">${label}</span>
    <div class="dbg-row__ctl">${children}</div>
    ${hint ? html`<span class="dbg-row__hint">${hint}</span>` : null}
  </div>`;
}

/**
 * The settings dialog of a debug room: the host edits a draft (取消 drops it, 恢复默认 sets every choice back to the
 * official match, 应用设置 sends it); everyone else sees the room's settings read-only.
 * @param {{ open: boolean, onClose: () => void, room: any, isHost: boolean }} props
 */
export function DebugConfigModal({ open, onClose, room, isHost }) {
  const opt = useDebugOptions(room);
  const names = debugNames();
  const [draft, setDraft] = useState(() => draftOf(room.debugConfig));
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  // every opening starts from the room's settings (a host's edit that was not applied is dropped)
  useEffect(() => { if (open) setDraft(draftOf(room.debugConfig)); }, [open]);
  if (!open) return null;
  const ro = !isHost;
  const d = ro ? draftOf(room.debugConfig) : draft;
  const set = (patch) => setDraft((x) => ({ ...x, ...patch }));
  const setStart = (patch) => setDraft((x) => ({ ...x, start: { ...x.start, ...patch } }));
  const setText = (patch) => setDraft((x) => ({ ...x, text: { ...x.text, ...patch } }));
  const toggleIn = (list, id, max = Infinity) => (list.includes(id) ? list.filter((x) => x !== id) : list.length < max ? [...list, id] : list);

  const apply = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await net.request('room.debugConfig', { config: wireOf(draft, opt) });
      toast(t('调试设置已更新'), 'success');
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const seats = Array.from({ length: opt.isSolo ? 1 : 4 }, (_, i) => (Array.isArray(room.seats) ? room.seats[i] : null) || null);
  const usedBands = (seat) => new Set(Object.entries(d.bands).filter(([k, v]) => k !== String(seat) && typeof v === 'string').map(([, v]) => v));
  const rounds = `1–${opt.bossRound}`;

  return html`<${Modal} open=${open} onClose=${onClose} title=${t('调试设置')} micro="DEBUG SETUP" tone="amber" width="min(9.6rem, 96vw)" class="dbg-modal"
    actions=${ro
      ? html`<${Button} variant="primary" icon="check" onClick=${onClose}>${t('关闭')}<//>`
      : html`<${Button} variant="ghost" icon="refresh" onClick=${() => setDraft(draftOf(defaultDebugConfig()))}>${t('恢复默认')}<//>
        <${Button} variant="secondary" onClick=${onClose}>${t('取消')}<//>
        <${Button} variant="amber" icon="check" loading=${busy} onClick=${apply}>${t('应用设置')}<//>`}>
    <div class="dbg-form">
      ${ro ? html`<p class="dbg-note dbg-note--ro"><${Icon} name="info" />${t('只有房主可以修改调试设置')}</p>` : null}

      <${Section} title=${t('开局')} micro="START">
        <${Row} label=${t('随机种子')} hint=${t('留空则每局随机；相同的种子会得到相同的战场、领袖、敌人和刷新结果')}>
          <${NumField} value=${d.text.seed} min="0" max=${DEBUG_LIMITS.seed} placeholder=${t('随机')} disabled=${ro} label=${t('随机种子')} onInput=${(v) => setText({ seed: v })} />
        <//>
        <${Row} label=${t('起始回合')} hint=${t('第 {r} 回合为最终攻势（{rounds}）', { r: opt.bossRound, rounds })}>
          <div class="dbg-step">
            <${Button} size="sm" square=${true} icon="minus" disabled=${ro || d.start.round <= 1} aria-label=${t('减少')} onClick=${() => setStart({ round: Math.max(1, d.start.round - 1) })} />
            <b class="dbg-step__val num">${d.start.round}</b>
            <${Button} size="sm" square=${true} icon="plus" disabled=${ro || d.start.round >= opt.bossRound} aria-label=${t('增加')} onClick=${() => setStart({ round: Math.min(opt.bossRound, d.start.round + 1) })} />
          </div>
        <//>
        <${Row} label=${t('起始资金')} hint=${t('留空则按回合收入')}>
          <${NumField} value=${d.text.funds} min="0" max=${DEBUG_LIMITS.funds} placeholder=${t('按规则')} disabled=${ro} label=${t('起始资金')} onInput=${(v) => setText({ funds: v })} />
        <//>
        <${Row} label=${t('调度中心等级')}>
          <${Chips} disabled=${ro} value=${d.start.level ?? 'auto'} onPick=${(id) => setStart({ level: id === 'auto' ? null : id })}
            items=${[{ id: 'auto', label: t('按规则') }, ...Array.from({ length: opt.maxLevel }, (_, i) => ({ id: i + 1, label: String(i + 1) }))]} />
        <//>
        <${Row} label=${t('生命值')} hint=${t('留空则按策略')}>
          <${NumField} value=${d.text.lp} min="1" max=${DEBUG_LIMITS.lp} placeholder=${t('按策略')} disabled=${ro} label=${t('生命值')} onInput=${(v) => setText({ lp: v })} />
        <//>
        <${Row} label=${t('锁血')} hint=${t('生命值不会降到 0，不会被淘汰（局内也可以切换）')}>
          <${Chips} disabled=${ro} value=${!!d.start.lockLp} onPick=${(v) => setStart({ lockLp: v })}
            items=${[{ id: false, label: tc('toggle', '关闭') }, { id: true, label: tc('toggle', '开启') }]} />
        <//>
        ${opt.hiddenRound ? html`<${Row} label=${t('隐秘核心')} hint=${t('开启后最终攻势胜利必定进入隐秘核心')}>
          <${Chips} disabled=${ro} value=${!!d.forceHidden} onPick=${(v) => set({ forceHidden: v })}
            items=${[{ id: false, label: t('按条件') }, { id: true, label: t('必定进入') }]} />
        <//>` : null}
      <//>

      <${Section} title=${t('战场')} micro="BATTLEFIELD">
        <${Chips} disabled=${ro} value=${d.stageId ?? 'auto'} onPick=${(id) => set({ stageId: id === 'auto' ? null : id })}
          items=${[{ id: 'auto', label: t('按难度随机') }, ...opt.stages.map((id) => ({ id, label: names.stage(id) }))]} />
      <//>

      <${Section} title=${t('敌方领袖')} micro="LEADERS">
        <${Row} label=${t('最终攻势')}>
          <${Chips} disabled=${ro} value=${d.bossId ?? 'auto'} onPick=${(id) => set({ bossId: id === 'auto' ? null : id })}
            items=${[{ id: 'auto', label: t('随机') }, ...opt.bosses.map((id) => ({ id, label: names.boss(id) }))]} />
        <//>
        <${Row} label=${t('隐秘核心')}>
          ${opt.hiddenRound
            ? html`<${Chips} disabled=${ro} value=${d.hiddenBossId ?? 'auto'} onPick=${(id) => set({ hiddenBossId: id === 'auto' ? null : id })}
                items=${[{ id: 'auto', label: t('随机') }, ...opt.hiddenBosses.map((id) => ({ id, label: names.boss(id) }))]} />`
            : html`<span class="t-dim">${t('本难度没有隐秘核心')}</span>`}
        <//>
      <//>

      <${Section} title=${t('禁用盟约')} micro="DISABLED BONDS" note=${t('一名干员的盟约全部被禁用时，这名干员不会出现在商店中')}>
        <${Chips} disabled=${ro} value=${d.bans.mode} onPick=${(mode) => set({ bans: { ...d.bans, mode } })}
          items=${[{ id: 'official', label: t('按官方随机') }, { id: 'none', label: t('全部开放') }, { id: 'custom', label: t('自定义') }]} />
        ${d.bans.mode === 'custom' ? html`<${Chips} multi=${true} disabled=${ro} value=${d.bans.bonds}
          onPick=${(id) => set({ bans: { ...d.bans, bonds: toggleIn(d.bans.bonds, id) } })}
          items=${[...opt.bonds.map((id) => ({ id, label: names.bond(id) })),
            ...opt.staticOffBonds.map((id) => ({ id, label: names.bond(id), disabled: true, off: true, title: t('本难度固定禁用') }))]} />` : null}
      <//>

      <${Section} title=${t('特训敌人')} micro="ENEMY TYPES" note=${t('最多 {n} 种；指定的类型各占 3 个回合，其余回合为特异敌人', { n: opt.maxFactions })}>
        <${Chips} multi=${true} disabled=${ro} value=${d.factions || []}
          onPick=${(id) => { const next = toggleIn(d.factions || [], id, opt.maxFactions); set({ factions: next.length ? next : null }); }}
          items=${opt.factionTypes.map((type) => ({ id: type, label: names.faction(type) }))} />
        <p class="dbg-note">${d.factions && d.factions.length ? t('已指定 {n} 种', { n: d.factions.length }) : t('未指定：按官方规则随机 {n} 种', { n: opt.maxFactions })}</p>
      <//>

      <${Section} title=${t('策略')} micro="STRATEGIES" note=${t('指定了策略的座位在策略轮选时自动选好，其余座位照常轮选')}>
        ${seats.map((s, i) => {
          const taken = usedBands(i);
          return html`<${Row} key=${i} label=${html`<span class="num">P${i + 1}</span> ${s ? s.name : t('空位')}`}>
            <select class="dbg-select" disabled=${ro} value=${d.bands[String(i)] || ''} aria-label=${t('P{n} 的策略', { n: i + 1 })}
              onChange=${(e) => { const v = e.currentTarget.value; set({ bands: { ...d.bands, [String(i)]: v || undefined } }); }}>
              <option value="">${t('轮选（不指定）')}</option>
              ${opt.bands.map((id) => html`<option key=${id} value=${id} disabled=${taken.has(id)}>${names.band(id)}</option>`)}
            </select>
          <//>`;
        })}
      <//>
    </div>
  <//>`;
}
