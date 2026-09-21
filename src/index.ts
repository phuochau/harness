export { main } from "./cli/main.js";
export { default as harnessExtension } from "./pi/extension.js";
export { createInMemoryHarnessSystem } from "./composition-root.js";
export { createHarnessSystem } from "./durable-composition-root.js";
export type { HarnessPorts, HarnessSystem } from "./composition-root.js";
