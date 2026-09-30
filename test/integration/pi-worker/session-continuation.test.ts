import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskSessionStore } from "../../../src/runtime/pi-worker/task-session.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function invokePi(cwd: string, agentDir: string, args: readonly string[]): Promise<{ code: number | null; output: string }> {
  const child = spawn(join(process.cwd(), "node_modules/.bin/pi"), [
    "--mode", "json", "--print", "--no-tools", "--no-extensions", "--no-skills",
    "--no-prompt-templates", "--no-context-files", "--no-themes", "--no-approve",
    "--provider", "fixture-provider", "--model", "fixture-model", ...args,
  ], {
    cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  return { code, output };
}

it("resumes a real Pi session from a different attempt worktree", async () => {
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk.toString();
    const body = JSON.parse(raw) as { messages?: unknown[] };
    requests.push(body);
    const text = requests.length === 1 ? "FIRST_TURN_MARKER" : "SECOND_TURN_MARKER";
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      id: `fixture-${requests.length}`, object: "chat.completion.chunk", created: 1,
      model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("fake server address missing");
    const root = await mkdtemp(join(tmpdir(), "harness-real-pi-resume-"));
    temporary.push(root);
    const agentDir = join(root, "agent");
    const sessions = join(root, "managed-sessions");
    const firstWorktree = join(root, "attempt-one");
    const secondWorktree = join(root, "attempt-two");
    await Promise.all([mkdir(agentDir), mkdir(sessions), mkdir(firstWorktree), mkdir(secondWorktree)]);
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "fixture-provider": {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "fixture-key", api: "openai-completions",
        models: [{ id: "fixture-model", name: "Fixture Model", contextWindow: 8192, maxTokens: 512 }],
      },
    } }));
    const sessionId = "12345678-1234-4123-8123-123456789abc";
    const store = new TaskSessionStore({ root: sessions });
    const managed = await store.create({ taskId: "T001", generation: 1, sessionId, profileId: "fixture-profile" });
    const first = await invokePi(firstWorktree, agentDir, [
      "--session-id", sessionId, "--session-dir", managed.sessionDir, "--", "Remember this exact phrase: ORIGIN_PHRASE_7.",
    ]);
    expect(first.code, first.output).toBe(0);
    expect(first.output).toContain("FIRST_TURN_MARKER");
    const files = (await readdir(managed.sessionDir)).filter((name) => name.endsWith(`_${sessionId}.jsonl`));
    expect(files).toHaveLength(1);
    const transcriptPath = join(managed.sessionDir, files[0]!);
    expect(await readFile(transcriptPath, "utf8")).toContain("ORIGIN_PHRASE_7");
    const verified = await store.verify("T001", { generation: 1, profileId: "fixture-profile" });
    expect(verified.status).toBe("ok");
    const second = await invokePi(secondWorktree, agentDir, [
      "--session", transcriptPath, "--", "What phrase did I ask you to remember?",
    ]);
    expect(second.code, second.output).toBe(0);
    expect(second.output).toContain("SECOND_TURN_MARKER");
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).toContain("ORIGIN_PHRASE_7");
  } finally {
    server.close();
  }
}, 30_000);
