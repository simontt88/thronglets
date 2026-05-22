import { createServer } from "http";
import { createHttpApp } from "./http.js";
import { attachWebSocket } from "./ws.js";
import type { FleetManager } from "../fleet/index.js";
import type { FleetEventBus } from "../fleet/index.js";
import type { BridgeConfig } from "../config.js";
import type { WorkspaceEntry } from "../fleet/index.js";

const DEFAULT_PORT = 3847;

export function startServer(
  fleet: FleetManager,
  bus: FleetEventBus,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): { port: number } {
  const port = parseInt(process.env.BRIDGE_PORT || "") || DEFAULT_PORT;

  const app = createHttpApp(fleet, config, workspaces);
  const server = createServer(app);
  attachWebSocket(server, fleet, bus, config, workspaces);

  server.listen(port, "127.0.0.1", () => {
    console.log(`[server] API: http://127.0.0.1:${port}`);
    console.log(`[server] WS:  ws://127.0.0.1:${port}/ws`);
  });

  return { port };
}
