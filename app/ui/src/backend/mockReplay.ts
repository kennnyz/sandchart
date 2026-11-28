// TEST-ONLY CODE. The real replay is `sandchart_core::replay` and `sandchart_core::aggregate` in
// Rust (simulate, stats, aggregation and the `.replay` file); this copy lets the browser mock
// answer, and mockReplay.test.ts checks it against the same fixture as Rust
// (crates/core/tests/fixtures/replay.json). See ADR 0008.
import { mockResolve } from "./mock";
import type { Instrument, ReplayCommand, ReplayStats, ReplayTrade, Side, TimeframeCode } from "./types";
import { TIMEFRAME_CODES } from "./types";
import { bucketStart as mockBucketStart, buildsFrom as mockBuildsFrom, closeTime as mockCloseTime, FIXED_MS } from "../timeframes";

export const MOCK_REPLAY_VERSION = 2;
export const MOCK_MAX_REPLAY_CANDLES = 200_000;
export const MOCK_MAX_REPLAY_COMMANDS = 10_000;
export const MOCK_MAX_REPLAY_BYTES = 32 * 1024 * 1024;
const MOCK_MAX_SCALE = 18;
const SAFE = Number.MAX_SAFE_INTEGER;

export interface MockCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** The bucket rules live in `src/timeframes.ts`; the mock reads them under its own names. */
export { bucketStart as mockBucketStart, buildsFrom as mockBuildsFrom, closeTime as mockCloseTime } from "../timeframes";

/** `aggregate` from Rust: `tf` candles from ascending `base` candles, the last bucket maybe partial. */
export function mockAggregate(candles: MockCandle[], base: TimeframeCode, tf: TimeframeCode): MockCandle[] {
  if (!mockBuildsFrom(tf, base)) throw new Error(`${tf} candles cannot be built from ${base} candles`);
  if (tf === base) return candles.map((c) => ({ ...c }));
  const out: MockCandle[] = [];
  for (const c of candles) {
    const start = mockBucketStart(tf, c.time);
    const b = out.at(-1);
    if (b && b.time === start) {
      b.high = Math.max(b.high, c.high);
      b.low = Math.min(b.low, c.low);
      b.close = c.close;
      b.volume += c.volume;
    } else {
      out.push({ ...c, time: start });
    }
  }
  return out;
}

/** `check_view` from the engine: why a replay stepping `base` cannot show `tf`, or null. */
export function mockViewError(base: TimeframeCode, tf: TimeframeCode): string | null {
  if (mockBuildsFrom(tf, base)) return null;
  if (mockBuildsFrom(base, tf)) return `the replay steps ${base} candles, so ${tf} candles cannot be built from them; re-base it to ${tf} first`;
  return `${tf} candles cannot be built from ${base} candles`;
}

/**
 * The mock's stand-in for the lower candles the engine loads on a re-base: `c` split into its
 * `lower` candles, which aggregate back to exactly `c` (the high in the first, the low in the second,
 * the close in the last). `lower` builds `base` and is shorter; neither is 1M.
 */
export function mockSplit(c: MockCandle, base: TimeframeCode, lower: TimeframeCode): MockCandle[] {
  const step = FIXED_MS[lower]!;
  const n = Math.round((mockCloseTime(base, c.time) - c.time) / step);
  if (n <= 1) return [{ ...c }];
  const share = Math.floor(c.volume / n);
  return Array.from({ length: n }, (_, k) => ({
    time: c.time + k * step,
    open: k === 0 ? c.open : c.close,
    high: k === 0 ? c.high : c.close,
    low: k === 0 ? Math.min(c.open, c.close) : k === 1 ? c.low : c.close,
    close: c.close,
    volume: k === n - 1 ? c.volume - share * (n - 1) : share,
  }));
}

/** `higher_candles` from the engine: `tf` candles built from `candles`, without a bucket they cover only in part at either end. */
export function mockHigher(candles: MockCandle[], base: TimeframeCode, tf: TimeframeCode): MockCandle[] {
  const out = mockAggregate(candles, base, tf);
  const first = candles[0];
  const last = candles.at(-1);
  if (first && out[0] && first.time > out[0].time) out.shift();
  const end = out.at(-1);
  if (last && end && mockCloseTime(tf, end.time) > mockCloseTime(base, last.time)) out.pop();
  return out;
}

/** `revealed` from Rust: the base candles that close at or before `cut`. */
export function mockRevealed(base: TimeframeCode, candles: MockCandle[], cut: number): MockCandle[] {
  const n = candles.findIndex((c) => mockCloseTime(base, c.time) > cut);
  return n < 0 ? candles : candles.slice(0, n);
}

/** Index of the candle that closes exactly at `t`, or -1. */
function closingAt(base: TimeframeCode, candles: MockCandle[], t: number): number {
  return candles.findIndex((c) => mockCloseTime(base, c.time) === t);
}

interface Running {
  side: Side;
  /** Index of the candle the trade was filled on. */
  entry: number;
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
    entryTime: candles[t.entry]!.time,
    entryPrice: t.entryPrice,
    initialStop: t.initialStop,
    stop: t.stop,
    take: t.take,
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
  // A bar that opens beyond the level (a gap) fills at its open.
  const open = candles[bar]!.open;
  const long = t.side === "long";
  if (out.status === "stop") return finish(t, candles, bar, long ? Math.min(t.stop, open) : Math.max(t.stop, open), "stop", out.ambiguous);
  return finish(t, candles, bar, long ? Math.max(t.take, open) : Math.min(t.take, open), "take", false);
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

/** `simulate` from Rust over `base` candles from the cut `start` to the cut `cut`: throws the same message on the first rule broken. */
export function mockSimulate(
  base: TimeframeCode,
  candles: MockCandle[],
  start: number,
  cut: number,
  commands: ReplayCommand[],
): { trades: ReplayTrade[]; stats: ReplayStats } {
  if (start > cut) throw new Error(`the start ${start} is after the cut ${cut}`);
  if (closingAt(base, candles, start) < 0) throw new Error(`the start ${start} is not the close time of a candle`);
  const current = closingAt(base, candles, cut);
  if (current < 0) throw new Error(`the cut ${cut} is not the close time of a candle`);
  if (commands.length > MOCK_MAX_REPLAY_COMMANDS) {
    throw new Error(`at most ${MOCK_MAX_REPLAY_COMMANDS} commands, not ${commands.length}`);
  }
  const trades: ReplayTrade[] = [];
  let open: Running | null = null;
  let lastTime = start;
  for (const [i, cmd] of commands.entries()) {
    const n = i + 1;
    const t = cmd.time;
    if (t < start || t > cut) throw new Error(`command ${n}: time ${t} is outside the replay (${start}..=${cut})`);
    if (t < lastTime) throw new Error(`command ${n}: time ${t} comes before time ${lastTime} of the previous command`);
    lastTime = t;
    const bar = closingAt(base, candles, t);
    if (bar < 0) throw new Error(`command ${n}: time ${t} is not the close time of a candle`);
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
      open = { side: cmd.side, entry: bar, entryPrice: close, initialStop: cmd.stop, stop: cmd.stop, take: cmd.take, next: bar + 1 };
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
        entryTime: candles[last.entry]!.time,
        entryPrice: last.entryPrice,
        initialStop: last.initialStop,
        stop: last.stop,
        take: last.take,
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

/** `Simulation::at_real_time` from Rust: the trade still open is unfinished; the stats stay. */
export function mockAtRealTime<T extends { trades: ReplayTrade[] }>(sim: T): T {
  const last = sim.trades.at(-1);
  if (last?.reason === "open") last.reason = "unfinished";
  return sim;
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
    if (t.reason === "open" || t.reason === "unfinished") continue;
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
  return {
    count,
    wins,
    losses,
    winRate: ratio(wins, count),
    totalR: total,
    averageR: ratio(total, count),
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
  /** The step resolution, the timeframe of `candles`. */
  base: TimeframeCode;
  candles: MockCandle[];
  /** The cut when the replay began. */
  start: number;
  /** The close time of the last revealed candle. */
  cut: number;
  commands: ReplayCommand[];
  /** The cut at which the replay caught up with real time, or null. */
  caughtUpAt: number | null;
}

/** `ReplayFile::simulate` from Rust: checks the catch-up time, simulates, ends the backtest there. */
export function mockSimulateFile(f: MockReplayFile) {
  if (f.caughtUpAt !== null) {
    if (f.caughtUpAt !== f.cut) throw new Error(`the replay caught up at ${f.caughtUpAt}, which is not its cut ${f.cut}`);
    if (mockRevealed(f.base, f.candles, f.cut).length !== f.candles.length) throw new Error("a replay that caught up has no candle after its cut");
  }
  const sim = mockSimulate(f.base, f.candles, f.start, f.cut, f.commands);
  return f.caughtUpAt === null ? sim : mockAtRealTime(sim);
}

/** The file text in Rust's layout (always version 2): one command and one candle per line. */
export async function mockWriteReplay(f: MockReplayFile): Promise<string> {
  const i = f.instrument;
  const instrument = { source: i.id.source, symbol: i.id.symbol, base: i.base, quote: i.quote, priceScale: i.priceScale, qtyScale: i.qtyScale };
  const lines = (items: string[]) => (items.length === 0 ? "[]" : `[\n    ${items.join(",\n    ")}\n  ]`);
  const commands = lines(f.commands.map((c) => JSON.stringify(c)));
  const candles = lines(f.candles.map((c) => `[${c.time}, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.volume}]`));
  return (
    `{\n  "version": ${MOCK_REPLAY_VERSION},\n  "instrument": ${JSON.stringify(instrument)},\n  "base": ${JSON.stringify(f.base)},\n` +
    `  "start": ${f.start},\n  "cut": ${f.cut},\n${f.caughtUpAt === null ? "" : `  "caughtUpAt": ${f.caughtUpAt},\n`}  "sha256": "${await mockCandleHash(f.candles)}",\n` +
    `  "commands": ${commands},\n  "candles": ${candles}\n}\n`
  );
}

/** Fields of each file version, and of its commands (`at`: the field that places a command). */
const SHAPES = {
  1: { file: ["version", "instrument", "timeframe", "start", "current", "sha256", "commands", "candles"], may: [], at: "bar" },
  2: { file: ["version", "instrument", "base", "start", "cut", "sha256", "commands", "candles"], may: ["caughtUpAt"], at: "time" },
} as const;
const INSTRUMENT_FIELDS = ["source", "symbol", "base", "quote", "priceScale", "qtyScale"];

/** serde's `deny_unknown_fields` and required fields: the first unknown key, then the first missing one. */
function fields(o: unknown, need: readonly string[], may: readonly string[] = []): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o)) throw new Error("invalid type: expected a map");
  const r = o as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!need.includes(k) && !may.includes(k) && k !== "kind") throw new Error(`unknown field \`${k}\``);
  for (const k of need) if (!(k in r)) throw new Error(`missing field \`${k}\``);
  return r;
}

/** An unsigned integer of `bits` bits, with serde's messages. */
function uint(v: unknown, bits: 8 | 32): number {
  const want = `u${bits}`;
  if (typeof v !== "number") throw new Error(`invalid type: ${JSON.stringify(v)}, expected ${want}`);
  if (!Number.isInteger(v)) throw new Error(`invalid type: floating point \`${v}\`, expected ${want}`);
  if (v < 0 || v >= 2 ** bits) throw new Error(`invalid value: integer \`${v}\`, expected ${want}`);
  return v;
}

function int(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`invalid type: ${JSON.stringify(v)}, expected i64`);
  return v;
}

function str(v: unknown): string {
  if (typeof v !== "string") throw new Error(`invalid type: ${JSON.stringify(v)}, expected a string`);
  return v;
}

/** The shape serde checks in Rust's `Body` (or `BodyV1`), `FileInstrument` and `Command`. */
function checkShape(raw: Record<string, unknown>, version: 1 | 2): void {
  const shape = SHAPES[version];
  fields(raw, shape.file, shape.may);
  if (raw.caughtUpAt !== undefined && raw.caughtUpAt !== null) int(raw.caughtUpAt);
  const i = fields(raw.instrument, INSTRUMENT_FIELDS);
  for (const k of ["source", "symbol", "base", "quote"]) str(i[k]);
  uint(i.priceScale, 8);
  uint(i.qtyScale, 8);
  str(version === 1 ? raw.timeframe : raw.base);
  const place = version === 1 ? (v: unknown) => uint(v, 32) : int;
  place(raw.start);
  place(version === 1 ? raw.current : raw.cut);
  str(raw.sha256);
  if (!Array.isArray(raw.commands)) throw new Error("invalid type: expected a sequence");
  if (raw.commands.length > MOCK_MAX_REPLAY_COMMANDS) throw new Error(`at most ${MOCK_MAX_REPLAY_COMMANDS} commands`);
  const kinds: Record<string, { need: string[]; may: string[] }> = {
    open: { need: [shape.at, "side", "stop", "take"], may: [] },
    edit: { need: [shape.at], may: ["stop", "take"] },
    close: { need: [shape.at], may: [] },
  };
  for (const c of raw.commands as unknown[]) {
    const kind = (c as { kind?: unknown } | null)?.kind;
    if (kind === undefined) throw new Error("missing field `kind`");
    const k = typeof kind === "string" ? kinds[kind] : undefined;
    if (!k) throw new Error(`unknown variant \`${String(kind)}\`, expected one of \`open\`, \`edit\`, \`close\``);
    const r = fields(c, k.need, k.may);
    place(r[shape.at]);
    if ("side" in r && r.side !== "long" && r.side !== "short") throw new Error(`unknown variant \`${String(r.side)}\`, expected \`long\` or \`short\``);
    for (const f of ["stop", "take"]) {
      // An edit's `Option<i64>` takes null as "not set".
      if (kind === "edit" && r[f] === null) delete r[f];
      else if (f in r) int(r[f]);
    }
  }
  if (!Array.isArray(raw.candles)) throw new Error("invalid type: expected a sequence");
  if (raw.candles.length > MOCK_MAX_REPLAY_CANDLES) throw new Error(`at most ${MOCK_MAX_REPLAY_CANDLES} candles`);
  for (const row of raw.candles as unknown[]) {
    if (!Array.isArray(row) || row.length !== 6) throw new Error("invalid length, expected an array of length 6");
    row.forEach(int);
  }
}

type V1Command = { kind: "open"; bar: number; side: Side; stop: number; take: number } | { kind: "edit"; bar: number; stop?: number; take?: number } | { kind: "close"; bar: number };

/** `from_v1` from Rust: each bar index becomes that bar's close time on the file's timeframe. */
function fromV1(tf: TimeframeCode, candles: MockCandle[], start: number, current: number, commands: V1Command[]) {
  if (start > current || current >= candles.length) {
    throw new Error(`start ${start} and current ${current} must satisfy start <= current < ${candles.length} candles`);
  }
  const close = (bar: number) => mockCloseTime(tf, candles[bar]!.time);
  const timed = commands.map((c, i): ReplayCommand => {
    if (c.bar < start || c.bar > current) throw new Error(`command ${i + 1}: bar ${c.bar} is outside the replay (${start}..=${current})`);
    const { bar, ...rest } = c;
    return { ...rest, time: close(bar) } as ReplayCommand;
  });
  return { start: close(start), cut: close(current), commands: timed };
}

/** Reads and checks a file of version 1 or 2 as Rust does (size, version, shape, limits, candles, hash, commands). */
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
  const version = raw.version;
  if (version !== 1 && version !== MOCK_REPLAY_VERSION) {
    throw new Error(`replay file version ${String(version)} is not supported (this app reads versions 1 and ${MOCK_REPLAY_VERSION})`);
  }
  try {
    checkShape(raw, version);
  } catch (e) {
    throw new Error(`not a replay file: ${e instanceof Error ? e.message : String(e)}`);
  }
  const inst = raw.instrument as Record<string, unknown>;
  const rows = raw.candles as number[][];
  const tf = (version === 1 ? raw.timeframe : raw.base) as TimeframeCode;
  if (!TIMEFRAME_CODES.includes(tf)) throw new Error(`unknown timeframe ${JSON.stringify(tf)}`);
  for (const [what, k] of [["price", "priceScale"], ["quantity", "qtyScale"]] as const) {
    const v = inst[k] as number;
    if (v > MOCK_MAX_SCALE) throw new Error(`the instrument's ${what} scale ${v} is above ${MOCK_MAX_SCALE}`);
  }
  for (const k of ["source", "symbol", "base", "quote"]) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(inst[k] as string)) {
      throw new Error(`the instrument's ${k} must be 1 to 64 characters from A-Z, a-z, 0-9, ., _ and -`);
    }
  }
  const candles = rows.map(([time, open, high, low, close, volume]) => ({
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
    if (c.low > Math.min(c.open, c.close)) throw new Error(`candle ${i}: low must be at most the open and the close`);
    if (c.high < Math.max(c.open, c.close)) throw new Error(`candle ${i}: high must be at least the open and the close`);
    if (c.volume < 0) throw new Error(`candle ${i}: volume must not be negative`);
    if (i > 0 && candles[i - 1]!.time >= c.time) throw new Error(`candle ${i}: open times must go up`);
  });
  if ((await mockCandleHash(candles)) !== raw.sha256) throw new Error("the candles do not match the file's sha256");
  const session =
    version === 1
      ? fromV1(tf, candles, raw.start as number, raw.current as number, raw.commands as V1Command[])
      : { start: raw.start as number, cut: raw.cut as number, commands: raw.commands as ReplayCommand[] };
  const caughtUpAt = version === 1 ? null : ((raw.caughtUpAt as number | null | undefined) ?? null);
  const file: MockReplayFile = {
    instrument: {
      id: { source: String(inst.source), symbol: String(inst.symbol) },
      base: String(inst.base),
      quote: String(inst.quote),
      priceScale: Number(inst.priceScale),
      qtyScale: Number(inst.qtyScale),
    },
    base: tf,
    candles,
    ...session,
    caughtUpAt,
  };
  mockSimulateFile(file);
  return file;
}
