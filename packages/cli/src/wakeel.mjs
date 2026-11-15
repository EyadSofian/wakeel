#!/usr/bin/env node
import { tsImport } from "tsx/esm/api";

const { runCli } = await tsImport("./main.ts", import.meta.url);
process.exitCode = await runCli(process.argv.slice(2), process.env, { print: console.log, error: console.error });
