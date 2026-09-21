import { describe, expect, it } from "vitest";
import {
  identityMismatchEvidence,
  type LiveProcessIdentity,
} from "../../../src/runtime/pi-process/identity.js";
import {
  processRecord,
  supervisorFixture,
} from "../../support/pi-process-fixtures.js";

describe("Pi process identity", () => {
  it("requires pid, start identity, executable, and attempt token", () => {
    const record = processRecord();
    const observed: LiveProcessIdentity = {
      pid: record.pid,
      startIdentity: "new-start",
      executable: "/usr/bin/other",
      attemptToken: "wrong-token",
    };
    expect(identityMismatchEvidence(observed, record)).toEqual([
      "start identity mismatch",
      "executable mismatch",
      "attempt token mismatch",
    ]);
  });

  it("refuses to signal a reused pid", async () => {
    const fixture = supervisorFixture({
      observed: {
        pid: 42,
        startIdentity: "new",
        executable: "/usr/bin/other",
        attemptToken: "token-1",
      },
    });
    await expect(
      fixture.supervisor.cancel(
        processRecord({
          pid: 42,
          startIdentity: "old",
          executable: "/managed/bin/pi",
        }),
        0,
      ),
    ).rejects.toThrow(/identity mismatch/);
    expect(fixture.signals).toEqual([]);
  });
});
