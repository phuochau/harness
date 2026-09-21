import { execa } from "execa";
import { expect, it } from "vitest";

function realCommand(): readonly string[] {
  const raw = process.env.HARNESS_E2E_COMMAND;
  if (raw === undefined) throw new Error("HARNESS_E2E_COMMAND is required");
  const value: unknown = JSON.parse(raw);
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw new Error("HARNESS_E2E_COMMAND must be a non-empty JSON argv array");
  }
  return value;
}

it.runIf(process.env.HARNESS_E2E_REAL === "1")(
  "runs an authenticated disposable feature through the installed harness",
  async () => {
    const repository = process.env.HARNESS_E2E_GITHUB_REPO;
    expect(repository).toMatch(/^[^/]+\/[^/]+$/);
    expect(process.env.HARNESS_E2E_DISPOSABLE).toBe("1");
    const argv = realCommand();
    const result = await execa(argv[0]!, argv.slice(1), {
      reject: false,
      timeout: 30 * 60_000,
      env: { ...process.env, HARNESS_E2E_GITHUB_REPO: repository },
    });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    const evidence = JSON.parse(result.stdout) as {
      runState?: unknown;
      pullRequest?: { repository?: unknown; url?: unknown };
      verified?: unknown;
    };
    expect(evidence).toMatchObject({
      runState: "DONE",
      verified: true,
      pullRequest: { repository },
    });
    expect(evidence.pullRequest?.url).toMatch(/^https:\/\//);
  },
  30 * 60_000,
);
