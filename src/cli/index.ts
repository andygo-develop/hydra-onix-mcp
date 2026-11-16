#!/usr/bin/env node
/**
 * CLI entry point (imported by `bin/hydra-onix-mcp.js`). The program itself is
 * built in `program.ts`, so it can be inspected without being run.
 */
import { main } from './program.js';

await main();
