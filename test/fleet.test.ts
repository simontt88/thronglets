import { FleetManager, FleetEventBus } from "../src/fleet/index.js";
import type { FleetEvent } from "../src/fleet/index.js";
import type { Runtime, AgentSession, RuntimeSessionOptions } from "../src/runtimes/interface.js";
import type { AgentDef, RuntimeType } from "../src/config.js";

class MockSession implements AgentSession {
  responses: string[];
  idx = 0;
  closed = false;

  constructor(responses: string[] = ["mock reply"]) {
    this.responses = responses;
  }

  async send(text: string): Promise<string> {
    return this.responses[this.idx++ % this.responses.length];
  }

  close(): void {
    this.closed = true;
  }
}

class MockRuntime implements Runtime {
  readonly name = "mock";
  sessions: MockSession[] = [];

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    const session = new MockSession([`[${opts.name}] reply from ${opts.cwd}`]);
    this.sessions.push(session);
    return session;
  }
}

function makeFleet() {
  const bus = new FleetEventBus();
  const events: FleetEvent[] = [];
  bus.onEvent((e) => events.push(e));

  const fleet = new FleetManager(bus, {
    workspaces: [
      { alias: "ws1", path: "/tmp/workspace-1" },
      { alias: "ws2", path: "/tmp/workspace-2" },
    ],
    createRuntime: () => new MockRuntime(),
    ensureRulesSync: async () => {},
    getAgentDef: (runtime: RuntimeType, model?: string) => ({
      name: runtime,
      runtime,
      apiKey: "test-key",
      model: model || "test-model",
    }),
  });

  return { fleet, bus, events };
}

async function testSpawn() {
  const { fleet, events } = makeFleet();

  const result = await fleet.spawn("alpha", "cursor", "ws1");
  console.assert(result.includes("alpha"), "spawn should mention agent name");
  console.assert(fleet.hasAgent("alpha"), "agent should exist after spawn");

  const status = fleet.getStatus();
  console.assert(status.total === 1, `total should be 1, got ${status.total}`);
  console.assert(status.idle === 1, `idle should be 1, got ${status.idle}`);
  console.assert(events.length === 1 && events[0].type === "agent_spawned", "should emit agent_spawned");
  console.log("✓ testSpawn passed");
}

async function testSpawnDuplicate() {
  const { fleet } = makeFleet();
  await fleet.spawn("alpha", "cursor", "ws1");
  const result = await fleet.spawn("alpha", "cursor", "ws1");
  console.assert(result.includes("already exists"), "duplicate spawn should error");
  console.log("✓ testSpawnDuplicate passed");
}

async function testSpawnInvalidWorkspace() {
  const { fleet } = makeFleet();
  const result = await fleet.spawn("alpha", "cursor", "nonexistent");
  console.assert(result.includes("Unknown workspace"), "invalid workspace should error");
  console.log("✓ testSpawnInvalidWorkspace passed");
}

async function testSend() {
  const { fleet, events } = makeFleet();
  await fleet.spawn("alpha", "cursor", "ws1");
  events.length = 0;

  const reply = await fleet.send("alpha", "hello world");
  console.assert(reply.includes("reply from"), `reply should contain runtime output, got: ${reply}`);

  const agent = fleet.getAgent("alpha")!;
  console.assert(agent.messageCount === 1, `messageCount should be 1, got ${agent.messageCount}`);
  console.assert(agent.status === "idle", `status should be idle after reply, got ${agent.status}`);

  const eventTypes = events.map((e) => e.type);
  console.assert(eventTypes.includes("user_message"), "should emit user_message");
  console.assert(eventTypes.includes("agent_message"), "should emit agent_message");
  console.assert(eventTypes.includes("session_started"), "should emit session_started");
  console.log("✓ testSend passed");
}

async function testSendToMissing() {
  const { fleet } = makeFleet();
  const reply = await fleet.send("ghost", "hello");
  console.assert(reply.includes("not found"), "send to missing should error");
  console.log("✓ testSendToMissing passed");
}

async function testKill() {
  const { fleet, events } = makeFleet();
  await fleet.spawn("alpha", "cursor", "ws1");
  await fleet.send("alpha", "test");
  events.length = 0;

  const result = await fleet.kill("alpha");
  console.assert(result.includes("killed"), "kill should confirm");
  console.assert(!fleet.hasAgent("alpha"), "agent should not exist after kill");
  console.assert(events.some((e) => e.type === "agent_killed"), "should emit agent_killed");
  console.log("✓ testKill passed");
}

async function testClear() {
  const { fleet, events } = makeFleet();
  await fleet.spawn("alpha", "cursor", "ws1");
  await fleet.send("alpha", "first message");

  const oldAgent = fleet.getAgent("alpha")!;
  const oldSessionId = oldAgent.currentSessionId;
  events.length = 0;

  const result = await fleet.clear("alpha");
  console.assert(result.includes("cleared"), "clear should confirm");

  const newAgent = fleet.getAgent("alpha")!;
  console.assert(newAgent.currentSessionId !== oldSessionId, "session ID should change");
  console.assert(newAgent.messageCount === 0, "message count should reset");
  console.assert(events.some((e) => e.type === "session_cleared"), "should emit session_cleared");
  console.log("✓ testClear passed");
}

async function testMultiAgent() {
  const { fleet } = makeFleet();
  await fleet.spawn("alpha", "cursor", "ws1");
  await fleet.spawn("beta", "claude-code", "ws2");

  const list = fleet.listAgents();
  console.assert(list.length === 2, `should have 2 agents, got ${list.length}`);
  console.assert(list.includes("alpha") && list.includes("beta"), "should have both agents");

  const replyA = await fleet.send("alpha", "test A");
  const replyB = await fleet.send("beta", "test B");
  console.assert(replyA.includes("workspace-1"), `alpha should route to ws1: ${replyA}`);
  console.assert(replyB.includes("workspace-2"), `beta should route to ws2: ${replyB}`);
  console.log("✓ testMultiAgent passed");
}

async function testConcurrentBlocking() {
  const { fleet } = makeFleet();
  await fleet.spawn("alpha", "cursor", "ws1");

  // First send
  const p1 = fleet.send("alpha", "first");
  // While first is in-flight, second should be rejected
  const p2result = await fleet.send("alpha", "second");
  console.assert(p2result.includes("still processing"), `concurrent should block: ${p2result}`);
  await p1;
  console.log("✓ testConcurrentBlocking passed");
}

async function runAll() {
  console.log("\n=== Fleet Manager Integration Tests ===\n");
  await testSpawn();
  await testSpawnDuplicate();
  await testSpawnInvalidWorkspace();
  await testSend();
  await testSendToMissing();
  await testKill();
  await testClear();
  await testMultiAgent();
  await testConcurrentBlocking();
  console.log("\n=== All tests passed ===\n");
}

runAll().catch((err) => {
  console.error("TEST FAILED:", err);
  process.exit(1);
});
