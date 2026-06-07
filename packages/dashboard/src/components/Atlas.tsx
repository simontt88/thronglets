import { useEffect } from "react";
import { useFleetStore, fetchAtlas, type AtlasItem, type Rarity, type ArtifactClass } from "../stores/fleet";

const RARITY_COLOR: Record<Rarity, string> = {
  common: "#9ca3af",
  uncommon: "#22c55e",
  rare: "#3b82f6",
  epic: "#a855f7",
  legendary: "#f59e0b",
};

const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common", uncommon: "Uncommon", rare: "Rare", epic: "Epic", legendary: "Legendary",
};

const CLASS_GLYPH: Record<ArtifactClass, string> = {
  tome: "📖", rune: "⚙️", crystal: "💎", tool: "🛠️", relic: "🗿",
};

const CLASS_LABEL: Record<ArtifactClass, string> = {
  tome: "Tome", rune: "Rune", crystal: "Crystal", tool: "Tool", relic: "Relic",
};

function basename(id: string): string {
  const parts = id.split("/");
  return parts[parts.length - 1];
}

function InvolvementBar({ item }: { item: AtlasItem }) {
  const total = item.read + item.edit + item.create + item.search || 1;
  const segs: Array<[string, number, string]> = [
    ["read", item.read, "#60a5fa"],
    ["edit", item.edit, "#fbbf24"],
    ["create", item.create, "#34d399"],
    ["search", item.search, "#c084fc"],
  ];
  return (
    <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
      {segs.map(([k, v, c]) => v > 0 ? (
        <div key={k} title={`${k}: ${v}`} style={{ width: `${(v / total) * 100}%`, background: c }} />
      ) : null)}
    </div>
  );
}

function LootCard({ item }: { item: AtlasItem }) {
  const color = RARITY_COLOR[item.rarity];
  return (
    <div
      className={"loot-card" + (item.live ? " loot-live" : "")}
      style={{
        borderColor: color,
        boxShadow: item.rarity === "legendary" || item.rarity === "epic" ? `0 0 16px ${color}44` : undefined,
      }}
      title={item.path}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="loot-glyph" style={{ background: `${color}22`, borderColor: color }}>
          <span style={{ fontSize: 20 }}>{CLASS_GLYPH[item.klass]}</span>
          <span className="loot-level" style={{ background: color }}>{item.level}</span>
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="loot-name" title={item.id}>{basename(item.id)}</div>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span className="loot-rarity" style={{ color }}>{RARITY_LABEL[item.rarity]}</span>
            <span className="loot-sub">· {CLASS_LABEL[item.klass]}</span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 8 }}>
        <InvolvementBar item={item} />
      </div>
      <div className="loot-meta">
        <span title="sessions that used this">🧩 {item.sessionCount}</span>
        <span title="throngs that discovered it">👾 {item.discoverers.length}</span>
        <span title="first discovered by">⛏ {item.firstDiscoveredBy}</span>
      </div>
    </div>
  );
}

export function Atlas() {
  const { atlasOpen, toggleAtlas, atlas, atlasSummary, atlasWorkspaces, currentWorkspace, setWorkspace } = useFleetStore();

  // refetch when opened or workspace changes
  useEffect(() => {
    if (atlasOpen) fetchAtlas(currentWorkspace);
  }, [atlasOpen, currentWorkspace]);

  useEffect(() => {
    if (!atlasOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") toggleAtlas(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atlasOpen]);

  if (!atlasOpen) return null;

  const totals = Object.values(atlasSummary).reduce(
    (acc, s) => ({ artifacts: acc.artifacts + s.artifacts, sessions: acc.sessions + s.sessions, legendary: acc.legendary + s.legendary, live: acc.live + s.live }),
    { artifacts: 0, sessions: 0, legendary: 0, live: 0 },
  );

  return (
    <div className="atlas-overlay" onClick={toggleAtlas}>
      <div className="atlas-panel" onClick={(e) => e.stopPropagation()}>
        <div className="atlas-header">
          <div className="atlas-title">🗺️ Artifact Atlas</div>
          <div className="atlas-totals">
            <span>{totals.artifacts} relics</span>
            <span>·</span>
            <span>{totals.sessions} quests</span>
            <span>·</span>
            <span style={{ color: RARITY_COLOR.legendary }}>{totals.legendary} legendary</span>
            {totals.live > 0 && <span style={{ color: "#34d399" }}>· {totals.live} live</span>}
          </div>
          <button className="icon-btn" onClick={toggleAtlas} title="Close (Esc)">✕</button>
        </div>

        <div className="atlas-realms">
          <button
            className={"realm-chip" + (currentWorkspace === "all" ? " active" : "")}
            onClick={() => setWorkspace("all")}
          >All realms</button>
          {atlasWorkspaces.filter((w) => w !== "unknown").map((w) => (
            <button
              key={w}
              className={"realm-chip" + (currentWorkspace === w ? " active" : "")}
              onClick={() => setWorkspace(w)}
            >
              {w}
              {atlasSummary[w]?.legendary > 0 && <span className="realm-badge">{atlasSummary[w].legendary}★</span>}
            </button>
          ))}
        </div>

        {atlas.length === 0 ? (
          <div className="atlas-empty">
            No relics discovered yet. As throngs work, the files they touch become loot —
            ranked by how widely they're used across sessions.
          </div>
        ) : (
          <div className="loot-grid">
            {atlas.map((item) => <LootCard key={`${item.workspace}/${item.id}`} item={item} />)}
          </div>
        )}
      </div>
    </div>
  );
}
