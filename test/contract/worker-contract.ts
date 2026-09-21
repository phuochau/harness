import { describe, expect, it } from "vitest";
import type { WorkerAdapterFactory } from "../../src/runtime/workers/types.js";
import {
  contractAssignment,
  nativeSessionRef,
  workerProbeContext,
} from "../support/worker-fixtures.js";

export function workerContract(
  name: string,
  factory: WorkerAdapterFactory,
): void {
  describe(name, () => {
    it("pins assignment, protected paths, tests, and Superpowers in the prompt", async () => {
      const adapter = factory();
      const assignment = contractAssignment({ workerKind: adapter.kind });
      const prepared = await adapter.prepare(assignment);
      expect(prepared.prompt).toContain(assignment.assignmentHash);
      expect(prepared.prompt).toContain("Do not modify spec.md");
      expect(prepared.prompt).toContain("npm test");
      expect(prepared.prompt).toContain("test-driven-development");
      expect(prepared.resultPath).toBe(
        `${assignment.worktree.path}/.harness-output/result.json`,
      );
    });

    it("returns invalid and never treats terminal prose as completion", () => {
      const adapter = factory();
      expect(adapter.parseResult("looks done", contractAssignment())).toEqual({
        status: "invalid",
        reason: expect.any(String),
      });
    });

    it("binds resume to the exact official session and assignment generation", async () => {
      const adapter = factory();
      const prepared = await adapter.prepare(
        contractAssignment({ workerKind: adapter.kind }),
      );
      const session = nativeSessionRef(adapter.kind, prepared.assignment);
      const capabilities = await adapter.probe(workerProbeContext());
      const spec = adapter.resumeSpec(prepared, session);
      expect(spec).toMatchObject(
        capabilities.nativeResume
          ? {
              status: "supported",
              session,
              assignmentHash: prepared.assignment.assignmentHash,
            }
          : { status: "unsupported" },
      );
      expect(() =>
        adapter.resumeSpec(prepared, { ...session, source: "herdr:other" }),
      ).toThrow(/session source/);
      expect(() =>
        adapter.resumeSpec(prepared, { ...session, attempt: 99 }),
      ).toThrow(/attempt generation/);
    });

    it("collects only the structured result bound to the assignment hash", async () => {
      const adapter = factory();
      const assignment = contractAssignment({ workerKind: adapter.kind });
      const prepared = await adapter.prepare(assignment);
      await expect(adapter.collect(prepared)).resolves.toMatchObject({
        status: "valid",
        result: { assignmentHash: assignment.assignmentHash },
      });
    });
  });
}

