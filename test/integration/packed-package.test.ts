import { afterEach, expect, it } from "vitest";
import {
  installPackedHarness,
  packHarness,
  type PackageConsumer,
  type PackedHarness,
} from "../support/package-consumer.js";

let packed: PackedHarness | undefined;
let consumer: PackageConsumer | undefined;
afterEach(async () => {
  await consumer?.cleanup();
  await packed?.cleanup();
  consumer = undefined;
  packed = undefined;
});

it("installs the tarball and loads both public entrypoints", async () => {
  packed = await packHarness();
  consumer = await installPackedHarness(packed, { pi: "0.86.1", typebox: "1.3.34" });
  await expect(consumer.exec("harness", ["--help"]))
    .resolves.toMatchObject({ exitCode: 0 });
  await expect(consumer.loadWithPiResourceLoader())
    .resolves.toMatchObject({ errors: [] });
  await expect(consumer.loadPublicEntrypoint()).resolves.toBeUndefined();
  expect(packed.files).not.toEqual(
    expect.arrayContaining([
      expect.stringMatching(/(?:^|\/)(?:test|\.harness-output)(?:\/|$)|events\.jsonl$/),
    ]),
  );
  expect(packed.files).toEqual(
    expect.arrayContaining([
      "bin/harness.mjs",
      "dist/index.js",
      "dist/pi/extension.js",
      "src/defaults/workflow.yaml",
    ]),
  );
}, 30_000);
