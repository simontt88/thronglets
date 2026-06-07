export interface RuntimeSessionOptions {
  cwd: string;
  model: string;
  context?: string;
  /** Session label (used for trace file names / correlation). */
  name?: string;
  /** Throng display name — what telemetry/activity feeds should attribute work to. */
  agentName?: string;
}

export interface AgentSession {
  send(text: string): Promise<string>;
  close(): void;
}

export interface Runtime {
  readonly name: string;
  createSession(opts: RuntimeSessionOptions): Promise<AgentSession>;
}
