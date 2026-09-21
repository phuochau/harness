import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { releaseManifest } from "../../../src/install/release-manifest.js";

it("keeps the packaged JSON release manifest identical to the built-in policy data", async () => {
  const document = JSON.parse(
    await readFile(resolve("src/defaults/release-manifest.json"), "utf8"),
  ) as { schema?: unknown; entries?: unknown };

  expect(document.schema).toBe("harness/release-manifest/v1");
  expect(document.entries).toEqual(releaseManifest);
});
