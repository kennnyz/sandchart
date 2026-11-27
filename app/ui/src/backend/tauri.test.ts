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
});
