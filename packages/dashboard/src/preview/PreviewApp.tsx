import { useMemo, useState } from "react";
import { PixelThronglet } from "../components/PixelThronglet";
import { SHOWCASE } from "./specs";
import { generateThronglet, type MoodName } from "../lib/thronglet";

const MOODS: MoodName[] = ["idle", "working", "talking", "happy", "skeptical", "sleeping", "dead"];

export function PreviewApp() {
  const [mood, setMood] = useState<MoodName>("idle");
  const [size, setSize] = useState(128);
  const [seedBucket, setSeedBucket] = useState(0);

  const random = useMemo(
    () => Array.from({ length: 24 }, (_, i) => generateThronglet(`rnd-${seedBucket}-${i}`)),
    [seedBucket]
  );

  return (
    <div style={page}>
      <header style={header}>
        <h1 style={h1}>Thronglets — Procedural Preview</h1>
        <p style={sub}>
          One base species silhouette. {SHOWCASE.length} hand-crafted specs below, plus 24 random ones
          from a syllable-name generator. Toggle mood to see the same creatures react.
        </p>

        <div style={controls}>
          <div style={ctlGroup}>
            <label style={lbl}>Mood</label>
            <div style={pillRow}>
              {MOODS.map((m) => (
                <button
                  key={m}
                  onClick={() => setMood(m)}
                  style={{
                    ...pill,
                    background: mood === m ? "#3a4060" : "#1a1e34",
                    color: mood === m ? "#fff" : "#a0a8c8",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div style={ctlGroup}>
            <label style={lbl}>Size</label>
            <input
              type="range"
              min={48}
              max={256}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              style={{ width: 180 }}
            />
            <span style={{ ...lbl, marginLeft: 8 }}>{size}px</span>
          </div>

          <div style={ctlGroup}>
            <button onClick={() => setSeedBucket((s) => s + 1)} style={primaryBtn}>
              Reroll random batch
            </button>
          </div>
        </div>
      </header>

      <section style={section}>
        <h2 style={h2}>8 Showcase specs (hand-crafted)</h2>
        <p style={smallSub}>These are the named examples from the plan — Vexo, Kilo, Paxi, etc.</p>
        <div style={grid8}>
          {SHOWCASE.map((spec) => (
            <Card key={spec.name} spec={spec} mood={mood} size={size} />
          ))}
        </div>
      </section>

      <section style={section}>
        <h2 style={h2}>24 random thronglets (procedural names + parts)</h2>
        <p style={smallSub}>
          Each card seeded from <code style={code}>generateThronglet("rnd-{seedBucket}-i")</code>.
          Click reroll above to see another batch.
        </p>
        <div style={gridRnd}>
          {random.map((spec) => (
            <Card key={spec.seed} spec={spec} mood={mood} size={96} compact />
          ))}
        </div>
      </section>

      <section style={section}>
        <h2 style={h2}>Same name → same creature (determinism check)</h2>
        <p style={smallSub}>
          The generator is a pure function of the agent name. The four below all use the
          name "Sparky" — they should be visually identical.
        </p>
        <div style={gridRnd}>
          {Array.from({ length: 4 }).map((_, i) => (
            <Card key={i} spec={generateThronglet("Sparky")} mood={mood} size={96} compact />
          ))}
        </div>
      </section>

      <footer style={footer}>
        Reference: <a href="https://kjp.artstation.com/projects/lG8LDk" target="_blank" rel="noopener" style={link}>
          official Thronglets art (Kevin Jean-Philippe)
        </a>
      </footer>
    </div>
  );
}

function Card({ spec, mood, size, compact }: { spec: any; mood: MoodName; size: number; compact?: boolean }) {
  return (
    <div style={{ ...card, padding: compact ? 10 : 16 }}>
      <PixelThronglet spec={spec} mood={mood} size={size} />
      <div style={{ marginTop: 8, textAlign: "center" }}>
        <div style={cardName}>{spec.name}</div>
        {!compact && (
          <div style={specRow}>
            <code style={code}>palette:{spec.palette}</code>{" "}
            <code style={code}>ears:{spec.ears}</code>{" "}
            <code style={code}>eyes:{spec.eyes}</code>{" "}
            <code style={code}>mouth:{spec.mouth}</code>{" "}
            <code style={code}>horn:{spec.horn}</code>{" "}
            <code style={code}>chest:{spec.chest}</code>{" "}
            <code style={code}>{spec.trait}</code>
          </div>
        )}
        {compact && <div style={smallSub}>{spec.palette} · {spec.trait}</div>}
      </div>
    </div>
  );
}

const page: React.CSSProperties = {
  background: "#0e1018",
  color: "#e0e4f8",
  minHeight: "100vh",
  padding: "32px 40px",
  fontFamily: "Nunito, system-ui, sans-serif",
};
const header: React.CSSProperties = { marginBottom: 32 };
const h1: React.CSSProperties = { fontSize: 28, fontWeight: 800, margin: 0, color: "#fff" };
const h2: React.CSSProperties = { fontSize: 18, fontWeight: 700, margin: "0 0 4px", color: "#fff" };
const sub: React.CSSProperties = { fontSize: 14, color: "#8e94b0", margin: "4px 0 16px", maxWidth: 720, lineHeight: 1.5 };
const smallSub: React.CSSProperties = { fontSize: 12, color: "#7e84a0", margin: "2px 0 14px" };
const section: React.CSSProperties = { marginBottom: 40 };
const controls: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 24,
  alignItems: "center",
  padding: 16,
  background: "#1a1e34",
  borderRadius: 12,
  border: "1px solid #2a3050",
};
const ctlGroup: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const lbl: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#7e84a0", textTransform: "uppercase", letterSpacing: 0.4 };
const pillRow: React.CSSProperties = { display: "flex", gap: 4 };
const pill: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 700,
  borderRadius: 14,
  border: "1px solid #2a3050",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 14px",
  background: "#3a4060",
  color: "#fff",
  border: "1px solid #4a5080",
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};
const grid8: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, 1fr)",
  gap: 12,
};
const gridRnd: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(6, 1fr)",
  gap: 10,
};
const card: React.CSSProperties = {
  background: "#15182a",
  border: "1px solid #2a3050",
  borderRadius: 12,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
};
const cardName: React.CSSProperties = { fontSize: 13, fontWeight: 800, color: "#fff", marginBottom: 4 };
const specRow: React.CSSProperties = { fontSize: 10, color: "#7e84a0", lineHeight: 1.6 };
const code: React.CSSProperties = {
  background: "#0e1018",
  padding: "1px 5px",
  borderRadius: 3,
  fontSize: 10,
  color: "#a0a8c8",
  fontFamily: "JetBrains Mono, ui-monospace, monospace",
};
const footer: React.CSSProperties = { marginTop: 32, fontSize: 11, color: "#5e6480", textAlign: "center" };
const link: React.CSSProperties = { color: "#7eb3e8", textDecoration: "underline" };
