import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import type { FleetManager } from "../fleet/index.js";
import type { FleetEventBus, FleetEvent } from "../fleet/index.js";
import type { BridgeConfig, RuntimeType } from "../config.js";
import type { WorkspaceEntry } from "../fleet/index.js";

export function attachWebSocket(
  server: Server,
  fleet: FleetManager,
  bus: FleetEventBus,
  config: BridgeConfig,
  workspaces: WorkspaceEntry[],
): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  bus.onEvent((event: FleetEvent) => {
    const msg = JSON.stringify({ type: "event", event });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  });

  wss.on("connection", (ws) => {
    // Send fleet snapshot on connect
    const status = fleet.getStatus();
    ws.send(JSON.stringify({
      type: "fleet_snapshot",
      agents: status.agents,
      workspaces: workspaces.map((w) => ({ alias: w.alias, path: w.path })),
      runtimes: config.agents.map((a) => ({ name: a.name, runtime: a.runtime, model: a.model })),
    }));

    ws.on("message", async (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.send(JSON.stringify({ type: "error", error: "Invalid JSON" }));
        return;
      }

      const { action } = msg;

      switch (action) {
        case "send": {
          const { agent, text } = msg;
          if (!agent || !text) {
            ws.send(JSON.stringify({ type: "error", error: "agent and text required" }));
            return;
          }
          try {
            const reply = await fleet.send(agent, text);
            ws.send(JSON.stringify({ type: "reply", agent, text: reply }));
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            ws.send(JSON.stringify({ type: "error", agent, error: errMsg }));
          }
          break;
        }

        case "spawn": {
          const { name, runtime, workspace, model } = msg;
          const rt = (runtime || "cursor") as RuntimeType;
          const ws_alias = workspace || workspaces[0]?.alias || "cwd";
          const result = await fleet.spawn(name, rt, ws_alias, model);
          ws.send(JSON.stringify({ type: "spawn_result", message: result }));
          break;
        }

        case "kill": {
          const result = await fleet.kill(msg.agent || msg.name);
          ws.send(JSON.stringify({ type: "kill_result", message: result }));
          break;
        }

        case "history": {
          const { agent, limit = 50 } = msg;
          const agentState = fleet.getAgent(agent);
          if (!agentState) {
            ws.send(JSON.stringify({ type: "error", error: `Agent "${agent}" not found` }));
            return;
          }
          const { getSessionsDir } = await import("../fleet/state.js");
          const { readFileSync } = await import("fs");
          const dir = getSessionsDir(agent);
          try {
            const file = `${dir}/${agentState.currentSessionId}.jsonl`;
            const lines = readFileSync(file, "utf-8").trim().split("\n");
            const events = lines.slice(-limit).map((l) => {
              try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
            ws.send(JSON.stringify({ type: "history", agent, events }));
          } catch {
            ws.send(JSON.stringify({ type: "history", agent, events: [] }));
          }
          break;
        }

        default:
          ws.send(JSON.stringify({ type: "error", error: `Unknown action: ${action}` }));
      }
    });
  });

  return wss;
}
