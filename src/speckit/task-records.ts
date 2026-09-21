import { posix } from "node:path";
import type { TaskNode } from "../contracts/task-graph.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { deepFreeze } from "../shared/deep-freeze.js";

export type CanonicalTaskRecord = TaskNode;

export class TaskRecordError extends Error {}

const recordKeys = [
  "acceptanceRefs",
  "dependsOn",
  "description",
  "id",
  "labels",
  "ownedPaths",
  "parallelEligible",
  "phase",
] as const;

function nfc(value: string): string {
  return value.normalize("NFC");
}

function closedObject(
  value: unknown,
  expectedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskRecordError(`${label} must be an object`);
  }
  const keys = Object.keys(value).sort();
  if (canonicalJson(keys) !== canonicalJson([...expectedKeys].sort())) {
    throw new TaskRecordError(`${label} has unknown or missing keys`);
  }
  return value as Record<string, unknown>;
}

function normalizedSet(
  value: unknown,
  label: string,
  validate?: (value: string) => string,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TaskRecordError(`${label} must be a JSON string array`);
  }
  const normalized = (value as string[]).map((item) => {
    const result = nfc(item);
    if (result === "") throw new TaskRecordError(`${label} contains an empty value`);
    return validate?.(result) ?? result;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new TaskRecordError(`${label} contains a duplicate set member`);
  }
  return normalized.sort();
}

function repositoryPath(value: string): string {
  if (
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TaskRecordError(`non-POSIX or unsafe owned path: ${value}`);
  }
  const normalized = posix.normalize(value);
  if (normalized !== value || normalized === ".") {
    throw new TaskRecordError(`non-canonical owned path: ${value}`);
  }
  return normalized;
}

function jsonStringArray(raw: string, label: string, path = false): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TaskRecordError(`${label} is not valid JSON`);
  }
  if (canonicalJson(parsed) !== raw) {
    throw new TaskRecordError(`${label} is not canonical JSON`);
  }
  return normalizedSet(parsed, label, path ? repositoryPath : undefined);
}

function visibleTask(line: string, phase: string): CanonicalTaskRecord {
  const depsToken = " | deps=";
  const acceptanceToken = " | ac=";
  const pathsToken = " | paths=";
  const deps = line.indexOf(depsToken);
  const acceptance = line.indexOf(acceptanceToken, deps + depsToken.length);
  const paths = line.indexOf(pathsToken, acceptance + acceptanceToken.length);
  if (deps === -1 || acceptance === -1 || paths === -1) {
    throw new TaskRecordError("task line is missing exact deps/ac/paths fields");
  }
  const prefix = line.slice(0, deps);
  const dependencyRaw = line.slice(deps + depsToken.length, acceptance);
  const acceptanceRaw = line.slice(acceptance + acceptanceToken.length, paths);
  const pathRaw = line.slice(paths + pathsToken.length);
  const match = /^- \[[ xX]\] (T[0-9]{3,})(?: (\[P\]))?((?: \[[A-Za-z0-9_-]+\])*) (.+)$/.exec(
    prefix,
  );
  if (!match) throw new TaskRecordError(`invalid task syntax: ${line}`);
  const [, id, parallelMarker, labelBlock = "", rawDescription] = match;
  const labels = [...labelBlock.matchAll(/ \[([A-Za-z0-9_-]+)\]/g)].map(
    (item) => nfc(item[1]!),
  );
  if (new Set(labels).size !== labels.length) {
    throw new TaskRecordError(`${id} contains duplicate labels`);
  }
  let description = "";
  for (let index = 0; index < rawDescription!.length; index += 1) {
    const character = rawDescription![index]!;
    if (character === "\\" && rawDescription![index + 1] === "|") {
      description += "|";
      index += 1;
    } else if (character === "|") {
      throw new TaskRecordError(`${id} description contains an unescaped pipe`);
    } else {
      description += character;
    }
  }
  description = nfc(description.trim());
  if (description === "") throw new TaskRecordError(`${id} description is empty`);
  return {
    id: id!,
    phase,
    labels: normalizedSet(labels, `${id} labels`),
    parallelEligible: parallelMarker === "[P]",
    description,
    dependsOn: jsonStringArray(dependencyRaw, `${id} dependencies`),
    acceptanceRefs: jsonStringArray(acceptanceRaw, `${id} acceptance refs`),
    ownedPaths: jsonStringArray(pathRaw, `${id} owned paths`, true),
  };
}

function normalizedMetadataRecord(value: unknown, index: number): CanonicalTaskRecord {
  const record = closedObject(value, recordKeys, `metadata task ${index + 1}`);
  if (
    typeof record.id !== "string" ||
    !/^T[0-9]{3,}$/.test(record.id) ||
    typeof record.phase !== "string" ||
    typeof record.description !== "string" ||
    typeof record.parallelEligible !== "boolean"
  ) {
    throw new TaskRecordError(`metadata task ${index + 1} has invalid scalar fields`);
  }
  const normalized: CanonicalTaskRecord = {
    id: nfc(record.id),
    phase: nfc(record.phase.trim()),
    description: nfc(record.description.trim()),
    parallelEligible: record.parallelEligible,
    labels: normalizedSet(record.labels, `${record.id} metadata labels`),
    dependsOn: normalizedSet(record.dependsOn, `${record.id} metadata dependencies`),
    acceptanceRefs: normalizedSet(
      record.acceptanceRefs,
      `${record.id} metadata acceptance refs`,
    ),
    ownedPaths: normalizedSet(
      record.ownedPaths,
      `${record.id} metadata owned paths`,
      repositoryPath,
    ),
  };
  if (canonicalJson(normalized) !== canonicalJson(record)) {
    throw new TaskRecordError(`metadata task ${record.id} is not normalized`);
  }
  return normalized;
}

export function parseSpecKitTasks(input: string): readonly CanonicalTaskRecord[] {
  const text = input.replace(/\r\n/g, "\n").normalize("NFC");
  const marker = "<!-- harness-task-metadata:v1\n";
  const markerIndex = text.indexOf(marker);
  if (markerIndex === -1 || markerIndex !== text.lastIndexOf(marker)) {
    throw new TaskRecordError("missing or duplicate metadata delimiter");
  }
  const metadataBlock = text.slice(markerIndex);
  const metadataMatch = /^<!-- harness-task-metadata:v1\n([^\n]+)\n-->$/.exec(
    metadataBlock,
  );
  if (!metadataMatch) {
    throw new TaskRecordError("metadata envelope must be the exact EOF block");
  }
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(metadataMatch[1]!);
  } catch {
    throw new TaskRecordError("metadata is not valid JSON");
  }
  if (canonicalJson(metadataValue) !== metadataMatch[1]) {
    throw new TaskRecordError("metadata JSON is not canonical or contains duplicate keys");
  }
  const metadata = closedObject(metadataValue, ["schema", "tasks"], "metadata root");
  if (metadata.schema !== "harness/task-metadata/v1" || !Array.isArray(metadata.tasks)) {
    throw new TaskRecordError("metadata root schema or tasks is invalid");
  }
  const metadataTasks = metadata.tasks.map(normalizedMetadataRecord);

  const visible = text.slice(0, markerIndex);
  const tasks: CanonicalTaskRecord[] = [];
  let phase: string | undefined;
  for (const line of visible.split("\n")) {
    if (line.startsWith("## Phase")) {
      const match = /^## Phase [0-9]+: (.+)$/.exec(line);
      if (!match) throw new TaskRecordError(`invalid phase heading: ${line}`);
      phase = nfc(match[1]!.trim());
      if (phase === "") throw new TaskRecordError("phase name is empty");
      continue;
    }
    if (line.startsWith("- [")) {
      if (phase === undefined) throw new TaskRecordError("task appears before a phase heading");
      tasks.push(visibleTask(line, phase));
    }
  }
  if (tasks.length === 0) throw new TaskRecordError("tasks.md contains no tasks");
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new TaskRecordError("duplicate task ID");
  if (canonicalJson(tasks) !== canonicalJson(metadataTasks)) {
    throw new TaskRecordError("metadata does not match visible task definition");
  }
  return deepFreeze(tasks);
}

