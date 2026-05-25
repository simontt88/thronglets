#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const cli = join(root, "src", "cli.ts");
const tsx = join(root, "node_modules", "tsx", "dist", "esm", "index.mjs");

try {
  execFileSync(process.execPath, ["--import", tsx, cli, ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: resolve(process.cwd()),
  });
} catch (err) {
  process.exit(err.status || 1);
}
