import { readFile, stat } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export class PackageRootError extends Error {}

export async function findPackageRoot(
  moduleLocation: string,
  expectedName: string,
): Promise<string> {
  const decoded = moduleLocation.startsWith("file:")
    ? fileURLToPath(moduleLocation)
    : resolve(moduleLocation);
  let current = decoded;
  try {
    if ((await stat(current)).isFile()) current = dirname(current);
  } catch {
    current = dirname(current);
  }
  const filesystemRoot = parse(current).root;
  while (true) {
    try {
      const packageDocument: unknown = JSON.parse(
        await readFile(resolve(current, "package.json"), "utf8"),
      );
      if (
        typeof packageDocument === "object" &&
        packageDocument !== null &&
        (packageDocument as { name?: unknown }).name === expectedName
      ) {
        return current;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new PackageRootError(`invalid package.json at ${current}`);
      }
    }
    if (current === filesystemRoot) break;
    current = dirname(current);
  }
  throw new PackageRootError(`could not locate package ${expectedName}`);
}
