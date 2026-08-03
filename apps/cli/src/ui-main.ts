#!/usr/bin/env node
import process from "node:process";

import { runConsoleUi } from "./ui-cli.js";

process.exitCode = await runConsoleUi(process.argv.slice(2), process.stdout, process.stderr);
