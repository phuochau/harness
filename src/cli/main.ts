import { Command } from "commander";
import { parseArgvJson } from "./command-detection.js";
import { initProject } from "./init.js";

export async function main(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name("harness")
    .description("Pi multi-agent orchestrator");
  program.command("version").action(() => {
    process.stdout.write("0.1.0\n");
  });
  program
    .command("init [path]")
    .description("Create an editable runnable harness workflow")
    .option("--task-verify <argv-json>", "task verification command as a JSON argv array")
    .option("--full-verify <argv-json>", "full verification command as a JSON argv array")
    .action(
      async (
        path: string | undefined,
        flags: { taskVerify?: string; fullVerify?: string },
      ) => {
        const hasTask = flags.taskVerify !== undefined;
        const hasFull = flags.fullVerify !== undefined;
        if (hasTask !== hasFull) {
          throw new Error("pass both --task-verify and --full-verify");
        }
        await initProject({
          root: path ?? ".",
          ...(!hasTask || !hasFull
            ? {}
            : {
                commands: {
                  taskVerify: parseArgvJson(flags.taskVerify!, "--task-verify"),
                  fullVerify: parseArgvJson(flags.fullVerify!, "--full-verify"),
                },
              }),
        });
      },
    );
  await program.parseAsync([...argv], { from: "user" });
  return 0;
}
