import { EventEmitter } from "events";
import type { FleetEvent, FleetEventType } from "./types.js";

export class FleetEventBus extends EventEmitter {
  publish(type: FleetEventType, agentName: string, sessionId: string, payload?: unknown): void {
    const event: FleetEvent = {
      ts: new Date().toISOString(),
      type,
      agentName,
      sessionId,
      payload,
    };
    super.emit("fleet_event", event);
  }

  onEvent(listener: (data: FleetEvent) => void): this {
    return super.on("fleet_event", listener);
  }
}
