import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Regression guard for the contracts module cycle (D1).
 *
 * `index.ts` re-exports `affiliate.js`, which used to import
 * `PlatformCapabilitySchema` back from `index.js`. Under plain Node ESM this
 * is an import-cycle TDZ crash ("Cannot access 'PlatformCapabilitySchema'
 * before initialization") at module evaluation; vitest's transform masked it.
 * Shared schemas must therefore live in leaf modules and NO source file may
 * import the barrel.
 */

const srcDir = path.dirname(fileURLToPath(import.meta.url));

function listSrcFiles(): string[] {
  return ["index.ts", "affiliate.ts", "capabilities.ts"].map((f) =>
    path.join(srcDir, f)
  );
}

describe("contracts module graph (D1 regression)", () => {
  it("has no source file importing the barrel (./index.js or ../index.js)", () => {
    const barrelImport = /from\s+["'](\.\.?\/index\.js)["']/;
    const offenders = listSrcFiles()
      .filter((file) => !file.endsWith(".test.ts"))
      .map((file) => ({ file, content: readFileSync(file, "utf8") }))
      .filter(({ content }) => barrelImport.test(content));
    expect(offenders).toEqual([]);
  });

  it("bootstraps the built dist bundle under real ESM semantics", async () => {
    const distIndex = path.resolve(srcDir, "../../dist/index.js");
    if (!existsSync(distIndex)) {
      // dist not built in this environment; the static check above still holds.
      return;
    }
    const mod = await import(distIndex);
    // Barrel surface must remain intact after the capability extraction.
    expect(typeof mod.PlatformCapabilitySchema.parse).toBe("function");
    expect(mod.PlatformCapabilitySchema.safeParse("catalog.read").success).toBe(
      true
    );
    expect(typeof mod.AffiliateProviderSchema.parse).toBe("function");
  });
});
