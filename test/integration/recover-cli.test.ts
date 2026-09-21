import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { main } from "../../src/cli/main.js";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("refuses standalone recovery before creating or mutating run state", async () => {
  const root = await mkdtemp(join(tmpdir(), "harness-recover-cli-"));
  temporary.push(root);

  await expect(main(["recover", "F023", root])).rejects.toThrow(
    /journal was not modified/,
  );
  expect(await readdir(root)).toEqual([]);
});
