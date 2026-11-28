import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const responses: Record<string, unknown> = {};
let finishReset: () => void = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
  invoke: vi.fn((cmd: string) => {
    calls.push(cmd);
    if (cmd === "unsubscribe_all") return new Promise<void>((r) => (finishReset = r));
    if (cmd in responses) return Promise.resolve(responses[cmd]);
    return Promise.resolve(cmd === "subscribe_live" ? 1 : undefined);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

describe("tauri backend", () => {
  it("subscribes only after the startup reset has finished", async () => {
    const { resetSubscriptions, tauriBackend } = await import("./tauri");
    void resetSubscriptions();
    const sub = tauriBackend.subscribeLive({ source: "binance", symbol: "BTCUSDT" }, "1h", () => {});
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["unsubscribe_all"]);

    finishReset();
    await sub;
    expect(calls).toEqual(["unsubscribe_all", "subscribe_live"]);
    // The reset runs once per page load.
    await tauriBackend.subscribeLive({ source: "binance", symbol: "ETHUSDT" }, "1h", () => {});
    expect(calls).toEqual(["unsubscribe_all", "subscribe_live", "subscribe_live"]);
  });

  it("maps null values to NaN, not 0", async () => {
    responses.compute_indicators = [
      {
        instance: "a",
        result: {
          ok: {
            firstTime: 1,
            lastTime: 3,
            series: [
              { id: "sma", data: { values: [1, null, 3] } },
              { id: "m", data: { markers: [{ index: 1, shape: "dot", text: null }] } },
            ],
            log: "",
          },
        },
      },
      { instance: "b", result: { err: "out of fuel" } },
    ];
    const { tauriBackend } = await import("./tauri");
    const [a, b] = await tauriBackend.computeIndicators({ source: "binance", symbol: "BTCUSDT" }, "1h", 0);
    const ok = "ok" in a!.result ? a!.result.ok : null;
    const values = (ok!.series[0]!.data as { values: Float64Array }).values;
    expect(values).toBeInstanceOf(Float64Array);
    expect(Array.from(values)).toEqual([1, NaN, 3]);
    expect(Number.isNaN(values[1])).toBe(true);
    expect(ok!.series[1]!.data).toEqual({ markers: [{ index: 1, shape: "dot", text: null }] });
    expect(b!.result).toEqual({ err: "out of fuel" });
  });

  it("sends module bytes as a plain number array", async () => {
    const seen: unknown[] = [];
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockImplementationOnce(((_cmd: string, args: { bytes: unknown }) => {
      seen.push(args.bytes);
      return Promise.resolve({ meta: {}, replaces: null });
    }) as never);
    const { tauriBackend } = await import("./tauri");
    await tauriBackend.inspectIndicator(new Uint8Array([0, 97, 115, 109]));
    expect(seen[0]).toEqual([0, 97, 115, 109]);
    expect(Array.isArray(seen[0])).toBe(true);
  });

  it("passes install progress from the channel to the callback", async () => {
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockImplementationOnce(((cmd: string, args: { onProgress: { onmessage: (m: unknown) => void } }) => {
      expect(cmd).toBe("install_update");
      args.onProgress.onmessage({ kind: "started", total: 10 });
      args.onProgress.onmessage({ kind: "installing" });
      return Promise.resolve();
    }) as never);
    const { tauriBackend } = await import("./tauri");
    const got: unknown[] = [];
    await tauriBackend.installUpdate((p) => got.push(p));
    expect(got).toEqual([{ kind: "started", total: 10 }, { kind: "installing" }]);
  });
  it("sends drawing commands with the Rust argument names", async () => {
    const seen: [string, unknown][] = [];
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockImplementation(((cmd: string, args: unknown) => {
      seen.push([cmd, args]);
      return Promise.resolve([]);
    }) as never);
    const { tauriBackend } = await import("./tauri");
    const id = { source: "binance", symbol: "BTCUSDT" };
    const position = { side: "long" as const, entry: { t: 1, p: 100 }, stop: 90, take: 120, endT: 2 };
    const drawing = {
      id: "d",
      instrument: id,
      priceScale: 2,
      body: { kind: "hline" as const, p: 1 },
      style: { color: 0, width: 1, dash: false },
      locked: false,
      hidden: false,
      z: 0,
    };
    await tauriBackend.getDrawings(id);
    await tauriBackend.saveDrawing(drawing);
    await tauriBackend.deleteDrawing("d");
    await tauriBackend.saveDrawings([drawing]);
    await tauriBackend.deleteDrawings(["d", "e"]);
    await tauriBackend.getPositionOutcomes(id, "1h", [{ id: "p", position }]);
    expect(seen).toEqual([
      ["get_drawings", { source: "binance", symbol: "BTCUSDT" }],
      ["save_drawing", { drawing }],
      ["delete_drawing", { id: "d" }],
      ["save_drawings", { drawings: [drawing] }],
      ["delete_drawings", { ids: ["d", "e"] }],
      ["get_position_outcomes", { source: "binance", symbol: "BTCUSDT", tf: "1h", positions: [{ id: "p", position }] }],
    ]);
  });

  it("sends replay commands with the Rust argument names and the file as raw bytes", async () => {
    const seen: [string, unknown][] = [];
    const core = await import("@tauri-apps/api/core");
    vi.mocked(core.invoke).mockImplementation(((cmd: string, args: unknown) => {
      seen.push([cmd, args]);
      return Promise.resolve(null);
    }) as never);
    const { tauriBackend } = await import("./tauri");
    const command = { kind: "open" as const, bar: 3, side: "long" as const, stop: 90, take: 120 };
    const file = new Uint8Array([123, 125]);
    await tauriBackend.replayStart({ source: "binance", symbol: "BTCUSDT" }, "4h", 7);
    await tauriBackend.replayStep(2);
    await tauriBackend.replayCommand(command);
    await tauriBackend.replayState(10, 3);
    await tauriBackend.replaySave();
    await tauriBackend.replayOpen(file);
    await tauriBackend.replayExit();
    expect(seen).toEqual([
      ["replay_start", { source: "binance", symbol: "BTCUSDT", tf: "4h", startTime: 7 }],
      ["replay_step", { n: 2 }],
      ["replay_command", { command }],
      ["replay_state", { cursor: 10, tradesFrom: 3 }],
      ["replay_save", undefined],
      ["replay_open", file],
      ["replay_exit", undefined],
    ]);
    expect(seen[5]![1]).toBeInstanceOf(Uint8Array);
  });
});
