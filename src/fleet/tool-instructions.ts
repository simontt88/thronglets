export function getToolInstructions(isDispatcher: boolean): string {
  if (isDispatcher) {
    return `
## Fleet Tools (you are the dispatcher — full control)

You can execute fleet operations by including markers in your reply:

- Send message to agent: [FLEET:fleet_send:{"agent":"name","text":"message"}]
- Spawn new agent: [FLEET:fleet_spawn:{"name":"agentname","runtime":"cursor|claude-code|codex","workspace":"alias"}]
- Kill agent: [FLEET:fleet_kill:{"name":"agentname"}]
- Clear agent session: [FLEET:fleet_clear:{"name":"agentname"}]
- Get fleet status: [FLEET:fleet_status:{}]
- Add workspace: [FLEET:fleet_workspace_add:{"alias":"short-name","path":"/absolute/path"}]
- List workspaces: [FLEET:fleet_workspace_list:{}]

You can include multiple markers in one reply. Results are logged to your session.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
  }

  return `
## Fleet Tools (limited — send messages only)

You can communicate with other agents by including markers in your reply:

- Send message to another agent: [FLEET:fleet_send:{"agent":"name","text":"message"}]
- Get fleet status: [FLEET:fleet_status:{}]

The message will be queued and the other agent will see it tagged with your name.
You CANNOT spawn, kill, or clear other agents — only the dispatcher can.
Include the marker anywhere in your reply text — it will be stripped before showing to the user.
`;
}
