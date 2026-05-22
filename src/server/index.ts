import { createServer } from "http";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { fileURLToPath } from "url";
import express from "express";
import { createHttpApp } from "./http.js";
import { attachWebSocket } from "./ws.js";
import type { FleetManager } from "../fleet/index.js";
import type { FleetEventBus } from "../fleet/index.js";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceEntry } from "../fleet/index.js";

const DEFAULT_PORT = 3847;

function findDashboardDist(): string | null {
  // Try relative to this file (works in dev and built mode)
  const candidates = [
    resolve(fileURLToPath(import.meta.url), "../../../packages/dashboard/dist"),
    resolve(process.cwd(), "packages/dashboard/dist"),
  ];
  for (const p of candidates) {
    if (existsSync(join(p, "index.html"))) return p;
  }
  return null;
}

export function startServer(
  fleet: FleetManager,
  bus: FleetEventBus,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): { port: number } {
  const port = parseInt(process.env.BRIDGE_PORT || "") || DEFAULT_PORT;

  const app = createHttpApp(fleet, config, workspaces);

  // Serve dashboard static files if built
  const dashDir = findDashboardDist();
  if (dashDir) {
    app.use(express.static(dashDir));
    // SPA fallback: any non-API route serves index.html
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api") || req.path.startsWith("/ws") || req.path === "/health") {
        return next();
      }
      res.sendFile(join(dashDir, "index.html"));
    });
    console.log(`[server] Dashboard: serving from ${dashDir}`);
  }

  const server = createServer(app);
  attachWebSocket(server, fleet, bus, config, workspaces);

  server.listen(port, "127.0.0.1", () => {
    console.log(`[server] API: http://127.0.0.1:${port}`);
    console.log(`[server] WS:  ws://127.0.0.1:${port}/ws`);
  });

  return { port };
}
