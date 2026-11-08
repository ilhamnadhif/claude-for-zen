#!/usr/bin/env node
import { main } from "../src/cli.js";

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`claude-for-zen: ${e?.stack || e}\n`);
  process.exit(1);
});
