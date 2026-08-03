#!/usr/bin/env node
import { runConsoleGateway } from "./runtime.js";

await runConsoleGateway(process.argv.slice(2));
