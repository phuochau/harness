import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  connectInstalledHerdr,
  installedHerdrSchemaHash,
} from "../../../src/runtime/herdr/client.js";
import { HERDR_SCHEMA_SHA256 } from "../../../src/runtime/herdr/protocol.generated.js";

it.runIf(process.env.HARNESS_COMPAT_HERDR === "1")(
  "matches the installed Herdr protocol",
  async () => {
    expect(await installedHerdrSchemaHash()).toBe(HERDR_SCHEMA_SHA256);
    const client = await connectInstalledHerdr();
    const cwd = await mkdtemp(join(tmpdir(), "pi-harness-herdr-compat-"));
    try {
      await expect(client.request("workspace.list", {})).resolves.toMatchObject({
        workspaces: expect.any(Array),
      });
      const created = await client.request("workspace.create", {
        cwd,
        label: `pi-harness-compat-${process.pid}`,
        focus: false,
      });
      await expect(
        client.request("workspace.close", {
          workspace_id: created.workspace.workspace_id,
        }),
      ).resolves.toEqual(expect.any(Object));
    } finally {
      client.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
