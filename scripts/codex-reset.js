#!/usr/bin/env node

const { runCodexMultiAuthCli } = await import("../dist/lib/codex-manager.js");
const exitCode = await runCodexMultiAuthCli(["reset", ...process.argv.slice(2)]);
process.exitCode = Number.isInteger(exitCode) ? exitCode : 1;
