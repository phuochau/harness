import { describe, expect, it } from "vitest";
import { processRecord, supervisorFixture } from "../../support/pi-process-fixtures.js";

describe("Pi process cancellation", () => {
  it("rechecks exact identity before each escalation signal", async () => {
    const fixture = supervisorFixture();
    fixture.identity.inspect = async () =>
      fixture.signals.includes("SIGKILL") ? undefined : fixture.identity.observed;
    const evidence = await fixture.supervisor.cancel(processRecord(), 0);
    expect(evidence.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(fixture.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });

  it("fails closed when the monitor disappears without provider identity", async () => {
    const fixture = supervisorFixture();
    fixture.identity.inspect = async () => {
      if (fixture.signals.length > 0) return undefined;
      return fixture.identity.observed;
    };
    await expect(fixture.supervisor.cancel(processRecord(), 0)).rejects.toThrow(
      "cannot verify cancellation after Pi monitor loss",
    );
    expect(fixture.signals).toEqual(["SIGINT"]);
  });
});
