import { describe, expect, it } from "vitest";
import { hasRing } from "./focus";

describe("focus rings", () => {
  it("reads no ring without an element or where :focus-visible is unknown", () => {
    expect(hasRing(null)).toBe(false);
    expect(hasRing({ matches: () => { throw new Error("unknown selector"); } } as unknown as Element)).toBe(false);
    expect(hasRing({ matches: (s: string) => s === ":focus-visible" } as unknown as Element)).toBe(true);
  });
});
