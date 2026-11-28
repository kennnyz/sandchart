import { describe, expect, it } from "vitest";
import fixture from "../../../../crates/core/tests/fixtures/alerts.json";
import { type MockLevel, type MockUpdate, mockFires, mockLevelAt, mockValidateAlert } from "./mockAlerts";
import type { AlertDirection, AlertKind } from "./types";

describe("mock alerts (TEST-ONLY copy of sandchart_core::alert)", () => {
  it("puts every fixture level where Rust does", () => {
    expect(fixture.levels.length).toBeGreaterThanOrEqual(15);
    for (const c of fixture.levels) expect(mockLevelAt(c.level as MockLevel, c.t), c.name).toBe(c.value);
  });

  it("fires on every fixture case like Rust", () => {
    expect(fixture.fires.length).toBeGreaterThanOrEqual(25);
    for (const c of fixture.fires) {
      const got = mockFires(c.direction as AlertDirection, c.level as MockLevel, c.prev as MockUpdate, c.cur as MockUpdate, c.sameStream);
      expect(got, c.name).toBe(c.fired);
    }
  });

  it("validates like Rust", () => {
    for (const c of fixture.invalid) expect(mockValidateAlert({ id: c.alert.id, kind: c.alert.kind as AlertKind }), c.name).toBe(c.error);
    for (const c of fixture.valid) expect(mockValidateAlert({ id: c.alert.id, kind: c.alert.kind as AlertKind }), c.name).toBeNull();
  });
});
