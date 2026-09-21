import { createServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { NewlineSocketHerdrTransport } from "../../../src/runtime/herdr/transport.js";

const temporary: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  await Promise.all(
    temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function socketServer(
  onRequest: (request: any, socket: Socket) => void,
): Promise<{ readonly path: string; readonly connections: () => number }> {
  const root = await mkdtemp(join(tmpdir(), "harness-herdr-transport-"));
  temporary.push(root);
  const path = process.platform === "win32"
    ? `\\\\.\\pipe\\harness-herdr-${process.pid}-${Date.now()}`
    : join(root, "herdr.sock");
  let connectionCount = 0;
  const server = createServer((socket) => {
    connectionCount += 1;
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const request = JSON.parse(buffer.slice(0, newline));
      onRequest(request, socket);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { path, connections: () => connectionCount };
}

it("uses a fresh connection when Herdr closes normal request sockets", async () => {
  const fixture = await socketServer((request, socket) => {
    socket.end(`${JSON.stringify({ id: request.id, result: { type: "ok" } })}\n`);
  });
  const transport = await NewlineSocketHerdrTransport.connect(fixture.path);

  await expect(transport.request({ id: "one", method: "ping", params: {} }))
    .resolves.toMatchObject({ id: "one" });
  await expect(transport.request({ id: "two", method: "workspace.list", params: {} }))
    .resolves.toMatchObject({ id: "two" });
  expect(fixture.connections()).toBe(2);
  transport.close();
});

it("keeps an event subscription connection after its acknowledgement", async () => {
  const fixture = await socketServer((request, socket) => {
    socket.write(`${JSON.stringify({ id: request.id, result: { type: "subscribed" } })}\n`);
    socket.write(`${JSON.stringify({ event: "workspace.created", data: { id: "w1" } })}\n`);
  });
  const transport = await NewlineSocketHerdrTransport.connect(fixture.path);
  const event = new Promise<unknown>((resolve) => {
    transport.subscribe(resolve);
  });

  await transport.request({
    id: "subscription",
    method: "events.subscribe",
    params: { subscriptions: [] },
  });
  await expect(event).resolves.toMatchObject({ event: "workspace.created" });
  expect(fixture.connections()).toBe(1);
  transport.close();
});
