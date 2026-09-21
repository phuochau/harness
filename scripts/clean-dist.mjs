import { rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const target = fileURLToPath(new URL("../dist", import.meta.url));
if (basename(target) !== "dist" || dirname(target) !== resolve(projectRoot)) {
  throw new Error(`refusing to clean unexpected build target: ${target}`);
}
await rm(target, { recursive: true, force: true });
