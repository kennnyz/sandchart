import { describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let finishReset: () => void = () => {};

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    onmessage: (e: unknown) => void = () => {};
  },
  invoke: vi.fn((cmd: string) => {
    calls.push(cmd);
    if (cmd === "unsubscribe_all") return new Promise<void>((r) => (finishReset = r));
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
});
