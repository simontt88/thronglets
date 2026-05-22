import type { AgentSession } from "../runtimes/interface.js";
import type { Runtime } from "../runtimes/interface.js";
import { SessionStore } from "./store.js";

interface ActiveSession {
  id: string;
  chatId: string;
  agent: AgentSession;
  messageCount: number;
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionManagerConfig {
  workspace: string;
  model: string;
  sessionTtlMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, ActiveSession>();
  private runtime: Runtime;
  private store: SessionStore;
  private config: SessionManagerConfig;
  private ttl: number;

  constructor(runtime: Runtime, store: SessionStore, config: SessionManagerConfig) {
    this.runtime = runtime;
    this.store = store;
    this.config = config;
    this.ttl = config.sessionTtlMs || 4 * 60 * 60 * 1000;
  }

  private generateId(): string {
    const date = new Date().toISOString().split("T")[0];
    const rand = Date.now().toString(36);
    return `bridge-${date}-${rand}`;
  }

  private isExpired(session: ActiveSession): boolean {
    return Date.now() - session.createdAt.getTime() > this.ttl;
  }

  async getOrCreate(chatId: string): Promise<ActiveSession> {
    const existing = this.sessions.get(chatId);
    if (existing && !this.isExpired(existing)) {
      existing.lastActivity = new Date();
      return existing;
    }

    // Expired or no session — clean up old one
    if (existing) {
      console.log(`[session] TTL expired for ${existing.id}, creating new`);
      try { existing.agent.close(); } catch {}
      this.sessions.delete(chatId);
    }

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
      lastActivity: new Date(),
    };

    this.sessions.set(chatId, session);
    console.log(`[session] created ${sessionId} for chat ${chatId}`);
    return session;
  }

  async send(chatId: string, text: string): Promise<string> {
    const session = await this.getOrCreate(chatId);
    session.messageCount++;
    session.lastActivity = new Date();

    this.store.log({ sessionId: session.id, chatId, role: "user", content: text });
    this.store.sync(session.id, "user", text).catch(() => {});

    const reply = await session.agent.send(text);

    this.store.log({ sessionId: session.id, chatId, role: "assistant", content: reply });
    this.store.sync(session.id, "assistant", reply).catch(() => {});

    return reply;
  }

  async clear(chatId: string): Promise<void> {
    const existing = this.sessions.get(chatId);
    if (existing) {
      try { existing.agent.close(); } catch {}
      this.sessions.delete(chatId);
      console.log(`[session] cleared ${existing.id} for chat ${chatId}`);
    }
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
