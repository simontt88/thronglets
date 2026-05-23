export interface RuntimeSessionOptions {
  cwd: string;
  model: string;
  context?: string;
  name?: string;
}

export interface AgentSession {
  send(text: string): Promise<string>;
  close(): void;
}

export interface Runtime {
  readonly name: string;
  createSession(opts: RuntimeSessionOptions): Promise<AgentSession>;
}
