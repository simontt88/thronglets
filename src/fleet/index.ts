export { FleetManager, FleetEventBus } from "./manager.js";
export type { FleetManagerConfig, WorkspaceEntry, PeerMessageCallback } from "./manager.js";
export { loadFleetState, saveFleetState, getSessionsDir, loadWorkspaces, addWorkspace, removeWorkspace } from "./state.js";
export type { FleetEvent, FleetEventType, AgentState, AgentStatus, FleetState, QueuedMessage, MessageSender } from "./types.js";
export { startDispatcher, getDispatcherConfig, DISPATCHER_AGENT_NAME } from "./dispatcher.js";
export { createPostReplyHook, getToolInstructions } from "./tools.js";
