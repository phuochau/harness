import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";

it("builds a runnable CLI and importable extension", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8"));
  expect(pkg.name).toBe("pi-multi-agent-harness");
  expect(pkg.pi.extensions).toEqual(["./dist/pi/extension.js"]);
  const result = await execa(process.execPath, ["bin/harness.mjs", "--help"], {
    cwd: process.cwd(),
  });
  expect(result.stdout).toContain("harness");
  await expect(access(resolve("dist/pi/extension.js"))).resolves.toBeUndefined();
  await expect(
    import(pathToFileURL(resolve("dist/pi/extension.js")).href),
  ).resolves.toHaveProperty("default");
});
