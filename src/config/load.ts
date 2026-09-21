import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  validateEnvironment,
  validateWorkflow,
  type EnvironmentDocument,
  type WorkflowDocument,
} from "../contracts/index.js";

export async function loadWorkflow(path: string): Promise<WorkflowDocument> {
  return validateWorkflow(parse(await readFile(path, "utf8")));
}

export async function loadEnvironment(
  path: string,
): Promise<EnvironmentDocument> {
  return validateEnvironment(parse(await readFile(path, "utf8")));
}
