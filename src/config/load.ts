import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  validateEnvironment,
  validateProfiles,
  validateWorkflow,
  type EnvironmentDocument,
  type ProfileDocument,
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

export async function loadProfiles(path: string): Promise<ProfileDocument> {
  return validateProfiles(parse(await readFile(path, "utf8")));
}
