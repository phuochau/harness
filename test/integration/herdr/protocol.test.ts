import { expect, it, vi } from "vitest";
import { HerdrClient, HerdrProtocolError } from "../../../src/runtime/herdr/client.js";
import {
  HERDR_PROTOCOL,
  HERDR_SCHEMA_SHA256,
  REQUIRED_HERDR_METHODS,
} from "../../../src/runtime/herdr/protocol.generated.js";
import {
  FakeHerdrTransport,
  workspaceListResponse,
} from "../../support/herdr-fixtures.js";

it("correlates responses and validates response payloads", async () => {
  const transport = new FakeHerdrTransport();
  const client = new HerdrClient(transport);
  const pending = client.request("workspace.list", {});
  expect(transport.requests[0]).toEqual({
    id: "harness-1",
    method: "workspace.list",
    params: {},
  });
  transport.receive(workspaceListResponse("harness-1", []));
  await expect(pending).resolves.toEqual({ type: "workspace_list", workspaces: [] });
  expect(HERDR_SCHEMA_SHA256).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(HERDR_PROTOCOL).toBeGreaterThan(0);
  expect(REQUIRED_HERDR_METHODS).toContain("agent.start");
});

it("rejects a response that does not match the generated schema", async () => {
  const transport = new FakeHerdrTransport();
  const client = new HerdrClient(transport);
  const pending = client.request("workspace.list", {});
  transport.receive({ id: "harness-1", result: { workspaces: [] } });
  await expect(pending).rejects.toBeInstanceOf(HerdrProtocolError);
});

it("validates subscription events before notifying listeners", () => {
  const transport = new FakeHerdrTransport();
  const client = new HerdrClient(transport);
  const listener = vi.fn();
  client.subscribe(listener);
  expect(() =>
    transport.receive({ event: "pane_agent_status_changed", data: {} }),
  ).toThrow(HerdrProtocolError);
  expect(listener).not.toHaveBeenCalled();
});

