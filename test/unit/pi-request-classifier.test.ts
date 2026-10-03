import { expect, it } from "vitest";
import { classifyPiRequest } from "../../src/pi/request-classifier.js";

it("returns no decision when Pi has no selected model", async () => {
  const result = await classifyPiRequest("Fix the project form", {
    model: undefined,
    modelRegistry: { complete: async () => { throw new Error("should not call"); } },
  } as never);
  expect(result).toBeUndefined();
});

it("classifies the literal request with the selected model and no tools", async () => {
  let sent: unknown;
  const result = await classifyPiRequest("Fix the project form", {
    model: { provider: "test", id: "model" },
    modelRegistry: {
      complete: async (_model: unknown, context: unknown) => {
        sent = context;
        return { stopReason: "stop", content: [{ type: "text", text: '{"route":"run","kind":"bugfix","reason":"Existing failure"}' }] };
      },
    },
  } as never);
  expect(result).toContain('"route":"run"');
  expect(sent).toMatchObject({
    messages: [{ role: "user", content: "Fix the project form" }],
  });
  expect((sent as { tools?: unknown }).tools).toBeUndefined();
});

it("treats model errors and incomplete replies as undecided", async () => {
  const result = await classifyPiRequest("Fix the project form", {
    model: { provider: "test", id: "model" },
    modelRegistry: { complete: async () => ({ stopReason: "error", content: [{ type: "text", text: "{}" }] }) },
  } as never);
  expect(result).toBeUndefined();
});
