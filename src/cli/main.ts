import { Command } from "commander";

export async function main(argv: readonly string[]): Promise<number> {
  const program = new Command()
    .name("harness")
    .description("Pi multi-agent orchestrator");
  program.command("version").action(() => {
    process.stdout.write("0.1.0\n");
  });
  await program.parseAsync([...argv], { from: "user" });
  return 0;
}
