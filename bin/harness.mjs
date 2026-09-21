#!/usr/bin/env node
const { main } = await import("../dist/cli/main.js");
process.exitCode = await main(process.argv.slice(2));
