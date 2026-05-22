import type { AgentSession } from "../runtimes/interface.js";
import type { Runtime } from "../runtimes/interface.js";
import { SessionStore } from "./store.js";

interface ActiveSession {
  id: string;
  chatId: string;
  agent: AgentSession;
  messageCount: number;
  createdAt: Date;
}

export interface SessionManagerConfig {
  workspace: string;
  model: string;
}

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private runtime: Runtime;
  private store: SessionStore;
  private config: SessionManagerConfig;

  constructor(runtime: Runtime, store: SessionStore, config: SessionManagerConfig) {
    this.runtime = runtime;
    this.store = store;
    this.config = config;
  }

  private generateId(): string {
    const date = new Date().toISOString().split("T")[0];
    const rand = Date.now().toString(36);
    return `bridge-${date}-${rand}`;
  }

  async getOrCreate(chatId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const sessionId = this.generateId();

    const agent = await this.runtime.createSession({
      cwd: this.config.workspace,
      model: this.config.model,
      context: "",
      name: `bridge-${chatId}-${sessionId.slice(-8)}`,
    });

    const session: ActiveSession = {
      id: sessionId,
      chatId,
      agent,
      messageCount: 0,
      createdAt: new Date(),
    };

    this.sessions.set(chatId, session);
    console.log(`[session] created ${sessionId} for chat ${chatId}`);
    return session;
  }

  async send(chatId: string, text: string): Promise<string> {
    const session = await this.getOrCreate(chatId);
    session.messageCount++;

    this.store.log({ sessionId: session.id, chatId, role: "user", content: text });
    await this.store.sync(session.id, "user", text);

    const reply = await session.agent.send(text);

    this.store.log({ sessionId: session.id, chatId, role: "assistant", content: reply });
    await this.store.sync(session.id, "assistant", reply);

    return reply;
  }

  async clear(chatId: string): Promise<string> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      existing.agent.close();
      this.sessions.delete(chatId);
      console.log(`[session] cleared ${existing.id} for chat ${chatId}`);
    }
    return this.generateId();
  }

  getStatus(chatId: string): { active: boolean; sessionId?: string; messageCount?: number } {
    const session = this.sessions.get(chatId);
    if (!session) return { active: false };
    return {
      active: true,
      sessionId: session.id,
      messageCount: session.messageCount,
    };
  }
}
