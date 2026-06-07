import { useEffect, useRef } from "react";
import { useFleetStore, fetchGame, getAgentAccent, type GameStats, type AgentState } from "../stores/fleet";

const MOOD_EMOJI: Record<GameStats["mood"], string> = {
  idle: "😴",
  thinking: "🧠",
  working: "⚙️",
  stuck: "😖",
  triumphant: "🎉",
  exhausted: "🥵",
};

/**
 * Telemetry can arrive keyed by a session label like "fleet-_dispatcher-s-…".
 * Resolve it back to the throng's friendly name so the feed reads like
 * "Orix read manager.ts" instead of a wall of session ids.
 */
function friendlyAgent(raw: string, agents: AgentState[]): string {
  let a = agents.find((x) => x.name === raw);
  if (!a) a = agents.find((x) => raw.includes(x.name));
  const base = a
    ? a.name
    : raw.replace(/^(fleet|ext|native)-/, "").replace(/-s-\d.*$/, "").replace(/-[0-9a-z]{5,}$/, "");
  return base === "_dispatcher" ? "Orix" : base;
}

/**
 * The fog-clearing panel: a live feed of what every throng is actually doing
 * (reads, edits, bash, tokens, model switches) plus per-throng game state
 * (level / XP / mood) — all derived from the gateway telemetry stream.
 */
export function ActivityTimeline() {
  const activity = useFleetStore((s) => s.activity);
  const gameStats = useFleetStore((s) => s.gameStats);
  const agents = useFleetStore((s) => s.agents);
  const open = useFleetStore((s) => s.activityOpen);
  const toggle = useFleetStore((s) => s.toggleActivity);
  const feedRef = useRef<HTMLDivElement>(null);

  // Initial + periodic game-state fetch
  useEffect(() => {
    fetchGame();
    const t = setInterval(fetchGame, 15000);
    return () => clearInterval(t);
  }, []);

  // Auto-scroll to newest
  useEffect(() => {
    if (feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [activity.length]);

  const accentFor = (raw: string): string => {
    let a = agents.find((x) => x.name === raw);
    if (!a) a = agents.find((x) => raw.includes(x.name));
    return a ? getAgentAccent(a) : "#888";
  };

  const statsList = Object.entries(gameStats).filter(([n]) => n !== "_dispatcher");

  // Keep the feed to events a human can read at a glance: what each throng
  // touched (tool calls), model switches, and anything that failed. Token/cost
  // ticks and "✓ ok" acknowledgements are dropped — cost already lives in the
  // per-throng badges above.
  const feed = activity.filter(
    (it) => it.kind === "tool_call" || it.kind === "model_switch" || it.ok === false,
  );

  if (!open) {
    return (
      <button className="activity-fab" onClick={toggle} title="Show activity timeline">
        ⚡ {feed.length > 0 ? feed.length : ""}
      </button>
    );
  }

  return (
    <div className="activity-panel">
      <div className="activity-header">
        <span>⚡ Live Activity</span>
        <button className="activity-close" onClick={toggle} title="Hide">✕</button>
      </div>

      {statsList.length > 0 && (
        <div className="activity-stats">
          {statsList.map(([name, st]) => (
            <div key={name} className="activity-badge" style={{ borderColor: accentFor(name) }}>
              <span className="ab-mood">{MOOD_EMOJI[st.mood]}</span>
              <span className="ab-name" style={{ color: accentFor(name) }}>{name}</span>
              <span className="ab-lvl">L{st.level}</span>
              <span className="ab-meta">{st.xp}xp · {st.specialty} · ${st.costUsd.toFixed(3)}</span>
              {st.testsPassed > 0 && <span className="ab-tests">✅{st.testsPassed}</span>}
            </div>
          ))}
        </div>
      )}

      <div className="activity-feed" ref={feedRef}>
        {feed.length === 0 && (
          <div className="activity-empty">Waiting for throng activity…<br /><small>which files each throng reads, edits & runs streams here</small></div>
        )}
        {feed.map((item) => (
          <div key={item.id} className={`activity-row${item.ok === false ? " is-error" : ""}`}>
            <span className="ar-agent" style={{ color: accentFor(item.agent) }}>{friendlyAgent(item.agent, agents)}</span>
            <span className="ar-summary">{item.summary}</span>
            <span className="ar-time">{new Date(item.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
