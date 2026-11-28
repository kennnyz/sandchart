// TEST-ONLY CODE. The real replay is `sandchart_core::replay` in Rust (simulate, stats and the
// `.replay` file); this copy lets the browser mock answer, and mock.test.ts checks it against
// the same fixture as Rust (crates/core/tests/fixtures/replay.json).
import { mockResolve } from "./mock";
import type { Instrument, ReplayCommand, ReplayStats, ReplayTrade, Side, TimeframeCode } from "./types";
import { TIMEFRAME_CODES } from "./types";

export const MOCK_REPLAY_VERSION = 1;
export const MOCK_MAX_REPLAY_CANDLES = 200_000;
export const MOCK_MAX_REPLAY_COMMANDS = 10_000;
export const MOCK_MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const SAFE = Number.MAX_SAFE_INTEGER;

export interface MockCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Running {
  side: Side;
  entryBar: number;
  entryPrice: number;
  initialStop: number;
  stop: number;
  take: number;
  /** The first bar not yet checked for a hit. */
  next: number;
}

const rAt = (t: Running, exit: number) => (exit - t.entryPrice) / (t.entryPrice - t.initialStop);

function finish(t: Running, candles: MockCandle[], bar: number, price: number, reason: ReplayTrade["reason"], ambiguous: boolean): ReplayTrade {
  return {
    side: t.side,
    entryBar: t.entryBar,
    entryTime: candles[t.entryBar]!.time,
    entryPrice: t.entryPrice,
    initialStop: t.initialStop,
    stop: t.stop,
    take: t.take,
    exitBar: bar,
    exitTime: candles[bar]!.time,
    exitPrice: price,
    reason,
    ambiguous,
    r: rAt(t, price),
  };
}

/** Bars `t.next..=to` checked with the position outcome, as Rust reuses `resolve_iter`. */
function advance(t: Running, candles: MockCandle[], to: number): ReplayTrade | null {
  if (t.next > to) return null;
  const from = t.next;
  t.next = to + 1;
  const bars = candles.slice(from, to + 1);
  const out = mockResolve(
    { side: t.side, entry: { t: candles[from - 1]!.time, p: t.entryPrice }, stop: t.stop, take: t.take, endT: candles[to]!.time },
    bars,
  );
  if (out.exitTime === null || out.status === "open") return null;
  const bar = from + bars.findIndex((c) => c.time >= out.exitTime!);
  return out.status === "stop" ? finish(t, candles, bar, t.stop, "stop", out.ambiguous) : finish(t, candles, bar, t.take, "take", false);
}

function checkLevels(side: Side, price: number, stop: number, take: number): string | null {
  for (const [name, v] of [["stop", stop], ["take", take]] as const) {
    if (!Number.isInteger(v) || Math.abs(v) > SAFE) return `${name} ${v} is outside ±(2^53 - 1)`;
  }
  if (side === "long" && !(stop < price && price < take)) {
    return `a long trade needs stop < price < take (stop ${stop}, price ${price}, take ${take})`;
  }
  if (side === "short" && !(take < price && price < stop)) {
    return `a short trade needs take < price < stop (take ${take}, price ${price}, stop ${stop})`;
  }
  return null;
}

/** `simulate` from Rust: throws the same message on the first command that breaks a rule. */
export function mockSimulate(
  candles: MockCandle[],
  start: number,
  current: number,
  commands: ReplayCommand[],
): { trades: ReplayTrade[]; stats: ReplayStats } {
  if (start > current || current >= candles.length) {
    throw new Error(`start ${start} and current ${current} must satisfy start <= current < ${candles.length} candles`);
  }
  if (commands.length > MOCK_MAX_REPLAY_COMMANDS) {
    throw new Error(`at most ${MOCK_MAX_REPLAY_COMMANDS} commands, not ${commands.length}`);
  }
  const trades: ReplayTrade[] = [];
  let open: Running | null = null;
  let lastBar = start;
  for (const [i, cmd] of commands.entries()) {
    const n = i + 1;
    const bar = cmd.bar;
    if (bar < start || bar > current) throw new Error(`command ${n}: bar ${bar} is outside the replay (${start}..=${current})`);
    if (bar < lastBar) throw new Error(`command ${n}: bar ${bar} comes before bar ${lastBar} of the previous command`);
    lastBar = bar;
    if (open) {
      const done = advance(open, candles, bar);
      if (done) {
        trades.push(done);
        open = null;
      }
    }
    const close = candles[bar]!.close;
    if (cmd.kind === "open") {
      if (open) throw new Error(`command ${n}: a trade is already open`);
      const bad = checkLevels(cmd.side, close, cmd.stop, cmd.take);
      if (bad) throw new Error(`command ${n}: ${bad}`);
      open = { side: cmd.side, entryBar: bar, entryPrice: close, initialStop: cmd.stop, stop: cmd.stop, take: cmd.take, next: bar + 1 };
    } else if (cmd.kind === "edit") {
      const t: Running | null = open;
      if (!t) throw new Error(`command ${n}: no open trade to edit`);
      if (cmd.stop === undefined && cmd.take === undefined) throw new Error(`command ${n}: an edit must set the stop or the take`);
      const s = cmd.stop ?? t.stop;
      const k = cmd.take ?? t.take;
      const bad = checkLevels(t.side, close, s, k);
      if (bad) throw new Error(`command ${n}: ${bad}`);
      t.stop = s;
      t.take = k;
    } else {
      const t: Running | null = open;
      if (!t) throw new Error(`command ${n}: no open trade to close`);
      trades.push(finish(t, candles, bar, close, "manual", false));
      open = null;
    }
  }
  const last = open as Running | null;
  if (last) {
    const done = advance(last, candles, current);
    trades.push(
      done ?? {
        side: last.side,
        entryBar: last.entryBar,
        entryTime: candles[last.entryBar]!.time,
        entryPrice: last.entryPrice,
        initialStop: last.initialStop,
        stop: last.stop,
        take: last.take,
        exitBar: null,
        exitTime: null,
        exitPrice: null,
        reason: "open",
        ambiguous: false,
        r: rAt(last, candles[current]!.close),
      },
    );
  }
  return { trades, stats: mockStats(trades) };
}

/** `stats` from Rust, summed in the same order. */
export function mockStats(trades: ReplayTrade[]): ReplayStats {
  let count = 0;
  let wins = 0;
  let losses = 0;
  let total = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let peak = 0;
  let maxDd = 0;
  let streak = 0;
  let longest = 0;
  for (const t of trades) {
    if (t.reason === "open") continue;
    count++;
    total += t.r;
    if (t.r > 0) {
      wins++;
      grossWin += t.r;
      streak = 0;
    } else if (t.r < 0) {
      losses++;
      grossLoss += t.r;
      streak++;
      longest = Math.max(longest, streak);
    } else {
      streak = 0;
    }
    peak = Math.max(peak, total);
    maxDd = Math.max(maxDd, peak - total);
  }
  const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
  const winRate = ratio(wins, count);
  const lossRate = ratio(losses, count);
  return {
    count,
    wins,
    losses,
    winRate,
    totalR: total,
    averageR: ratio(total, count),
    expectancy: winRate * ratio(grossWin, wins) + lossRate * ratio(grossLoss, losses),
    profitFactor: losses > 0 ? grossWin / -grossLoss : null,
    maxDrawdownR: maxDd,
    longestLosingStreak: longest,
  };
}

/** Lowercase hex SHA-256 over six little-endian int64 per candle, as `candle_hash` in Rust. */
export async function mockCandleHash(candles: MockCandle[]): Promise<string> {
  const buf = new DataView(new ArrayBuffer(candles.length * 48));
  candles.forEach((c, i) => {
    [c.time, c.open, c.high, c.low, c.close, c.volume].forEach((v, j) => buf.setBigInt64(i * 48 + j * 8, BigInt(v), true));
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buf.buffer));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface MockReplayFile {
  instrument: Instrument;
  tf: TimeframeCode;
  candles: MockCandle[];
  start: number;
  current: number;
  commands: ReplayCommand[];
}

/** The file text in Rust's layout: one command and one candle per line. */
export async function mockWriteReplay(f: MockReplayFile): Promise<string> {
  const i = f.instrument;
  const instrument = { source: i.id.source, symbol: i.id.symbol, base: i.base, quote: i.quote, priceScale: i.priceScale, qtyScale: i.qtyScale };
  const lines = (items: string[]) => (items.length === 0 ? "[]" : `[\n    ${items.join(",\n    ")}\n  ]`);
  const commands = lines(f.commands.map((c) => JSON.stringify(c)));
  const candles = lines(f.candles.map((c) => `[${c.time}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}]`));
  return (
    `{\n  "version": ${MOCK_REPLAY_VERSION},\n  "instrument": ${JSON.stringify(instrument)},\n  "timeframe": ${JSON.stringify(f.tf)},\n` +
    `  "start": ${f.start},\n  "current": ${f.current},\n  "sha256": "${await mockCandleHash(f.candles)}",\n` +
    `  "commands": ${commands},\n  "candles": ${candles}\n}\n`
  );
}

/** Reads and checks a file as Rust does (size, version, limits, candles, hash, commands). */
export async function mockReadReplay(bytes: Uint8Array): Promise<MockReplayFile> {
  if (bytes.length > MOCK_MAX_REPLAY_BYTES) {
    throw new Error(`the replay file is ${Math.floor(bytes.length / 2 ** 20)} MiB; the limit is 32 MiB`);
  }
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not an object");
  } catch (e) {
    throw new Error(`not a replay file: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (raw.version !== MOCK_REPLAY_VERSION) {
    throw new Error(`replay file version ${String(raw.version)} is not supported (this app reads version ${MOCK_REPLAY_VERSION})`);
  }
  const inst = raw.instrument as Record<string, unknown> | undefined;
  const rows = raw.candles;
  if (!inst || !Array.isArray(rows) || !Array.isArray(raw.commands) || typeof raw.start !== "number" || typeof raw.current !== "number") {
    throw new Error("not a replay file: missing fields");
  }
  const tf = raw.timeframe as TimeframeCode;
  if (!TIMEFRAME_CODES.includes(tf)) throw new Error(`unknown timeframe ${JSON.stringify(raw.timeframe)}`);
  if (rows.length > MOCK_MAX_REPLAY_CANDLES) throw new Error(`at most ${MOCK_MAX_REPLAY_CANDLES} candles, not ${rows.length}`);
  const candles = (rows as number[][]).map(([time, open, high, low, close, volume]) => ({
    time: time!,
    open: open!,
    high: high!,
    low: low!,
    close: close!,
    volume: volume!,
  }));
  candles.forEach((c, i) => {
    for (const v of [c.time, c.open, c.high, c.low, c.close, c.volume]) {
      if (!Number.isInteger(v) || Math.abs(v) > SAFE) throw new Error(`candle ${i}: ${v} is outside ±(2^53 - 1)`);
    }
    if (i > 0 && candles[i - 1]!.time >= c.time) throw new Error(`candle ${i}: open times must go up`);
  });
  if ((await mockCandleHash(candles)) !== raw.sha256) throw new Error("the candles do not match the file's sha256");
  const file: MockReplayFile = {
    instrument: {
      id: { source: String(inst.source), symbol: String(inst.symbol) },
      base: String(inst.base),
      quote: String(inst.quote),
      priceScale: Number(inst.priceScale),
      qtyScale: Number(inst.qtyScale),
    },
    tf,
    candles,
    start: raw.start,
    current: raw.current,
    commands: raw.commands as ReplayCommand[],
  };
  mockSimulate(file.candles, file.start, file.current, file.commands);
  return file;
}
