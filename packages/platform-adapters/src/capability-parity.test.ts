import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLATFORM_CAPABILITIES } from "./types.js";

/**
 * ADT-1 contract-parity guard: the local capability copy in this package
 * must never drift from packages/contracts. Checked two ways — against the
 * contracts source text (always available) and against the built dist barrel
 * when it exists.
 */
const srcDir = path.dirname(fileURLToPath(import.meta.url));

describe("capability parity with @zaff/contracts", () => {
  it("matches the contracts source enum exactly", () => {
    const contractsSrc = path.resolve(
      srcDir,
      "../../contracts/src/capabilities.ts"
    );
    const text = readFileSync(contractsSrc, "utf8");
    const match = text.match(/z\.enum\(\[([^\]]*)\]/);
    expect(match).not.toBeNull();
    const contractCaps =
      match?.[1]?.split(",")
        .map((s) => s.trim().replaceAll('"', ""))
        .filter(Boolean)
        .sort() ?? [];
    expect([...PLATFORM_CAPABILITIES].sort()).toEqual(contractCaps);
  });

  it("matches the built contracts dist enum when dist exists", async () => {
    const distIndex = path.resolve(srcDir, "../../contracts/dist/index.js");
    if (!existsSync(distIndex)) {
      return;
    }
    const mod = await import(distIndex);
    const options: string[] = mod.PlatformCapabilitySchema.options;
    expect(new Set(options)).toEqual(new Set(PLATFORM_CAPABILITIES));
  });
});
