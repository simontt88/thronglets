export { FleetManager } from "./manager.js";
export type { FleetManagerConfig, WorkspaceEntry } from "./manager.js";
export { FleetEventBus } from "./event-bus.js";
export { loadFleetState, saveFleetState, getSessionsDir, getFleetDir } from "./state.js";
export type { FleetEvent, FleetEventType, AgentState, AgentStatus, FleetState } from "./types.js";
export { startDispatcher, getDispatcherConfig, buildDispatcherContext, DISPATCHER_AGENT_NAME } from "./dispatcher.js";
