# DESIGN §27 — Debug rooms

Part of [DESIGN.md](../DESIGN.md) (the index; section numbers are global).

## 27. Debug rooms (DBUG) — a remake tool for testing

The official mode has nothing like it: a debug room is a room of this remake whose match can be set up and steered to
reproduce a problem quickly — the battlefield, the leaders, the disabled bonds, the 特训敌人 types and the start state
before the match; funds, the 调度中心 level, LP, bond layers, operators and items taken at will, the battle speed, the
pause, the prep countdown, ending a battle and jumping to a round during it. A contributor's proposal of 2026-10-08
(the pull request that added it). Nothing of it reaches an ordinary match: every rule below applies only to a room
created as a debug room and to its matches, which carry the DEBUG mark wherever they are shown.

Where each part is handled: the way in → §27.1; the pre-game settings and the match setup → §27.2; the in-match
operations → §27.3; time control → §27.4; the LP lock and what an ordinary match keeps → §27.5; the tests → §27.6.

### 27.1 The way in: the DBUG key, the two switches, the confirmation — `shared/constants.js DEBUG_ROOM_CODE`, `server/lobby.js`, `server/http/config.js parseDebugRooms`, `public/js/ui/debugMode.js`, `public/js/ui/settings.js`, `public/js/screens/lobby.js`

- **The key.** `DBUG` (`DEBUG_ROOM_CODE`) typed into 加入同盟 — or a `?room=DBUG` link — creates a new debug room of the
  mode and difficulty chosen in the lobby: `room.create { mode, difficulty, debug: true }`. DBUG is never a room's own
  key (`Lobby.genCode` skips it); the debug room gets an ordinary 4-letter key, shared like any other. `room.join
  { code: 'DBUG' }` itself finds no room (`ROOM_NOT_FOUND`); 观战 with DBUG is refused in the client with a hint.
- **The client switch.** 设置 → 调试模式 (`DebugToggle`; per browser in `localStorage` `sp.pref.debugMode`, off by
  default): without it DBUG only shows 「请先在「设置」中开启调试模式，再输入 DBUG」. The lobby's top bar has a gear
  button for the settings (it had none). Joining or spectating somebody's debug room by its key needs no switch.
- **The server switch.** Debug rooms are open unless the server starts with `SP_DEBUG=0` (also `false` / `off` / `no` /
  `never`; the `startServer()` option `debugRooms` wins over the environment): then `room.create { debug: true }` answers
  `DEBUG_OFF` (此服务器已关闭调试模式), every `welcome` carries `debugRooms: false`, and the settings switch is greyed out
  with the same line.
- **The confirmation.** Every way into a debug room asks first, amber, 「你即将进入 DEBUG Mode 房间」 with what the room
  can change and that its matches are not real simulations: before DBUG creates one, and when `room.join` / `room.spectate`
  of a key answers `DEBUG_CONFIRM` — the client asks and sends the request again with `debugAck: true`
  (`ui/debugMode.js joinWithAck`, also behind a `?room=` link and the recent keys). A member of the room (a spectator
  taking a free seat) is not asked again.
- **The mark.** `room.state.debug: true`; the room title, the in-match top bar (`m.public.debug`) and the result screen
  show 「⚠ DEBUG 运行中」 (`ui/debugRoom.js DebugBadge`), in amber like everything of the debug tools.

### 27.2 The pre-game settings and the match setup — `shared/debug.js`, `server/lobby.js setDebugConfig`, `server/match/Match.js`, `server/match/waves.js setupMatchWaves`, `server/match/pool.js bansFor`, `public/js/ui/debugRoom.js`

`room.debugConfig { config }` (the host, in LOBBY only — `ROOM_STARTED` during the match, `NOT_HOST` / `SPECTATOR` for
anyone else, `BAD_MSG` in an ordinary room) sets the room's settings; `room.state.debugConfig` shows them to everyone —
the room bar under the seats sums up what differs from an official match (「全部按正式规则」 when nothing does), the host's
修改 opens the settings dialog, everyone else's 查看 the same dialog read-only. The server checks a config leniently against
what the room's mode offers (`debugOptions(tables, modeId)` — the same reading of the data as the match; `normalizeDebugConfig`):
an unknown id is dropped, a number is clamped into its range, the result is always complete. A change un-readies the other
humans like a difficulty change; a difficulty change checks the settings again against the new mode.

| setting | values (the mode's own lists) | default |
|---|---|---|
| `seed` | an integer 0 … 2³²−1 — the match seed: the same battlefield, leaders, bans, enemies and shop rolls each time | `null`: a new seed each match |
| `stageId` | a battlefield in use (active, weight > 0: the 8 of 险境) | `null`: the official draw (标准: 战场#01) |
| `bossId` / `hiddenBossId` | a Final Assault / Hidden Core leader of the mode (weight > 0; none without a Hidden Core) | `null`: the official draw |
| `forceHidden` | a won Final Assault always opens the Hidden Core (modes with one) | `false` |
| `bans` | `{ mode: 'official' \| 'none' \| 'custom', bonds }` — the official draw, no bond disabled, or the host's list of the bonds the match may disable (the mode's own inactive bonds stay off) | `official` |
| `factions` | ≤ 3 (`maxFactions`) of the 特训敌人 types a match draws from (`involveRandom`) | `null`: the official draw |
| `start` | `{ round: 1 … bossRound, funds: 0 … 999 \| null, level: 1 … maxShopLevel \| null, lp: 1 … 999 \| null, lockLp }` | round 1, the rest as the match gives it |
| `bands` | `{ [seat]: bandId }` — a strategy of the mode type per seat (a co-op duplicate keeps the lowest seat, 队友已选) | `{}`: the draft as usual |

The match gets the settings (`opts.debug`, frozen) and `opts.hostId()` (the room's host now: the rights of §27.3); the
lobby starts it with the room's seed when one is set.

- **Setup.** `setupMatchWaves` and `drawDisabledBonds` make every official draw as in any match and the settings replace
  the results (`overrides`; the bans through `bansFor`, which also bans the visible chess whose every bond is off) — so
  the random streams after them are those of an ordinary match with the same seed, and the 15-round schedule is built
  from the chosen 特训敌人 types (each takes 3 rounds, the other rounds are 特异 as in the official rule).
- **Start state.** When the strategy draft opens, the strategies set by seat are picked (`_debugPresetBands`; never one
  a teammate holds) and the other seats draft as usual. BATTLE_CHECK starts `start.round` instead of round 1
  (`_firstRound`). That first round's shop is rolled at `start.level` (`_debugStartLevel`, before `PlayerState.startRound`),
  and after its start — income, `<进入休整期时>` effects — `start.funds` and `start.lp` replace what it gave
  (`_debugStartState`), for every player still in, AI seats included. `start.lockLp` is the LP lock's first state (§27.5).

### 27.3 The in-match operations — `server/match/match/debug.js`, `shared/debug.js DEBUG_OPS / checkDebugOp`, `public/js/ui/debugPanel.js`, `public/js/ui/gameLogic/debug.js`

A debug match's corner has a **DBG** button that opens the debug panel (tabs 状态 / 时间 / 取用; above everything but
dialogs, the paused overlay included). Each button sends `g.debug { op, target?, id?, value?, on?, mode? }`; an ordinary
match answers `BAD_MSG 'not a debug match'`. `target` is a playerId — absent, the requester; another player (AI seats
included) is the host's right (`NOT_HOST`); a target must still be in (`BAD_TARGET` after it left, `ELIMINATED`). What
the viewer may not use now is greyed out with the reason (`debugOpState`); the server decides.

| op | fields | who / when | effect |
|---|---|---|---|
| `funds.set` | `value` 0 … 999 | target · prep | funds = value |
| `funds.add` | `value` −999 … 999 | target · prep | `addFunds` (a gain never past 999) |
| `level.set` | `value` 1 … maxShopLevel | target · prep | the level written, its upgrade price, the shop re-rolled at it (frozen cards kept) — no upgrade effect |
| `level.up` | — | target · prep | an upgrade without its price: the new shop slots, the ticker, `onLevelUp` (`MAX_LEVEL` at the top) |
| `lp.set` | `value` 1 … 999 | target · prep; once the team LP exists (from the Final Assault on): in a prep or a leader battle | LP = value — the team LP once it exists (shared out as usual) |
| `lp.lock` | `on` | host · any time | the LP lock (§27.5) |
| `layers.set` | `id` bond, `value` 0 … 999 | target · prep | the bond's layers written (0 removes them), nothing triggered |
| `layers.add` | `id` bond, `value` 1 … 999 | target · prep | a gain like any effect's: `onLayers` fires, the 999 cap holds |
| `chess.grant` | `id` chess, `value?` 1 … 3 | target · prep | 取用: copies into the 整备区 (overflow 临时整备区), holding no copy of the shared pool; three copies merge into the elite as usual (the 晋升奖励 included); an elite id gives the elite; a 自选 slot only as the player's own pick; `HAND_FULL` when none fits |
| `item.grant` | `id` item, `value?` 1 … 3 | target · prep | 取用 of an item the same way |
| `speed.set` | `value` 1 \| 2 \| 4 | host · any time | the battle speed (§27.4) |
| `prep.freeze` | `on` | host · any time | the prep countdown frozen (§27.4) |
| `battle.end` | `mode` | host · a battle | ends the running battle phase (§27.4) |
| `round.jump` | `value` 1 … bossRound | host · prep | the prep ends without a battle, round `value` starts (§27.4) |

`m.public.debug` (debug matches only) = `{ speed, lockLp, freezePrep, forceHidden, startRound }` — the live switches the
panel, the DEBUG mark and the browsers' runners follow. The 取用 tab lists the operators (by tier, class, bond, name; 特殊
for those the shop never offers; the player's own 自选 picks apart) and the items (elite versions marked) of the data.

### 27.4 Time control — `server/match/match/debug.js`, `server/match/match/pause.js`, `public/js/battle/runner.js setSpeed`, `public/js/screens/game.js`

- **Speed.** 1×, 2× (the official, forced speed — §4: 60 ticks per real second) or 4× (the cap the contributor chose so
  that weak browsers keep up). A battle is fixed 1/30 s ticks, so its result is the same at any speed — only how fast it
  plays changes. A change in a battle rebases every field clock (`startAt`, the boss clock) so no battle jumps, moves the
  HUD `deadline` / `overtimeAt` and the result deadlines to the new pace, and the browsers' runners rebase their local
  clocks on `m.public.debug.speed` (`setSpeed`); a new battle starts at the current speed (`b.start.speed`). The
  server-run mode (`SP_COMBAT=server`) paces its fields at `gameSpeed` too.
- **Pause.** The solo pause (§14 Solo pause) also serves a debug co-op match: its host may pause a battle, 联防 included
  (anyone else → `NOT_HOST`) — from the panel in any battle, from the top bar's button or `Space` while the host's own
  battle runs (`ui/matchStatus.js pauseAvailable`) — and resume it from the paused overlay or the panel.
- **The prep countdown.** `prep.freeze { on: true }` stops it — what was left is kept — and every prep that starts
  frozen is untimed: the battle starts once every player is ready. `{ on: false }` runs the rest of the frozen prep, or
  the whole prep time of one that started frozen. A single human's prep is untimed anyway (§18.2).
- **Ending a battle.** A normal round or 联防: `natural` — the battle's own result at once (the spec simulated to its
  end on the server), `leak` — cut at the field clock, the enemies on the field counted as leaked (a timeout), `kill` —
  cut there, the enemies left not counted; the browsers showing it get `b.end` and the round settles as usual. A
  Final Assault / Hidden Core: `win` empties the leader's pool, `lose` the team LP (the LP lock does not hold it).
- **Jumping.** `round.jump n` from a prep: the prep ends as at its deadline (`<休整期结束时>` effects, the temp resolved),
  there is no battle and no settlement, and round n starts (`_debugJumpNow`) — the boss round is the Final Assault, with
  its own prep; the 进入最终攻势 button jumps there.

### 27.5 The LP lock, and what an ordinary match keeps — `server/match/match/settle.js`, `server/match/match/bossRounds.js _teamLpLoss`

- **The LP lock** (`start.lockLp`, `lp.lock`): settlement never takes a player below 1 LP and the team LP stops at 1
  (overtime included), so nobody is eliminated and no leader battle is lost by LP; `battle.end lose` still empties the
  team LP. A 1-LP debug match stays at 1 while locked.
- **Everything else is the official match.** The rules, the AI seats, the 机变 drafts, the results and the titles are those
  of any match; an operator or item taken counts as acquired (promotions, the 晋升奖励). A debug match's result screen
  carries the DEBUG mark.
- **An ordinary match is unchanged**: `this.debug` is null, no setting is read and no random stream moves — the golden
  results are the same. `g.debug` answers `BAD_MSG` there and `g.pause` keeps its solo-only rule.

### 27.6 Tests

`test/lobby-debug.test.js` (the way in, the switches, the confirmation, the host's settings — server and client sides),
`test/match/debug.test.js` (the setup overrides against an ordinary match of the same seed, the start state, every
operation with its rights and phases, speed, pause, the frozen countdown, ending a battle, jumping, the LP lock, a debug
room fuzzed with the match invariants), `test/debug.test.js` (`shared/debug.js`), `test/ui/debug.test.js`
(`ui/gameLogic/debug.js`, `ui/debugMode.js`), `test/ui/debug.e2e.test.js` (the whole flow in a browser, `SP_E2E=1`);
`test/match/fuzz.test.js` sends `g.debug` to ordinary matches (`BAD_MSG`, never `INTERNAL`).

---
