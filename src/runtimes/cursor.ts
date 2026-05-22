import { Agent } from "@cursor/sdk";
import type { Runtime, AgentSession, RuntimeSessionOptions } from "./interface.js";

export interface CursorConfig {
  apiKey: string;
  model: string;
}

class CursorSession implements AgentSession {
  private agent: Awaited<ReturnType<typeof Agent.create>>;

  constructor(agent: Awaited<ReturnType<typeof Agent.create>>) {
    this.agent = agent;
  }

  async send(text: string): Promise<string> {
    const run = await this.agent.send(text);
    const result = await run.wait();
    return result.result || "(no response)";
  }

  close(): void {
    this.agent.close();
  }
}

export class CursorRuntime implements Runtime {
  readonly name = "cursor";

  constructor(private config: CursorConfig) {}

  async createSession(opts: RuntimeSessionOptions): Promise<AgentSession> {
    const agent = await Agent.create({
      apiKey: this.config.apiKey,
      model: { id: opts.model || this.config.model },
      name: opts.name || `bridge-${Date.now().toString(36)}`,
      local: { cwd: opts.cwd },
    });

    // Inject workspace context as first message
    if (opts.context) {
      const run = await agent.send(opts.context);
      await run.wait();
    }

    return new CursorSession(agent);
  }
}
