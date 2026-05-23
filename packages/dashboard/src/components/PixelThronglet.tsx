import { useEffect, useMemo, useState } from "react";
import { COLOR, GRID, PALETTES, composeGrid, type MoodName, type ThrongletSpec } from "../lib/thronglet";

interface Props {
  spec: ThrongletSpec;
  mood?: MoodName;
  size?: number;
  showName?: boolean;
}

export function PixelThronglet({ spec, mood = "idle", size = 96, showName = false }: Props) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 600), 120);
    return () => clearInterval(id);
  }, []);

  const grid = useMemo(() => composeGrid(spec, mood, frame), [spec, mood, frame]);
  const palette = PALETTES[spec.palette];
  const cell = size / GRID;

  const colorFor = (idx: number): string | null => {
    switch (idx) {
      case COLOR.BODY:       return palette.body;
      case COLOR.BODY_SHADE: return palette.bodyShade;
      case COLOR.BODY_LITE:  return palette.bodyLite;
      case COLOR.EARS:       return palette.ears;
      case COLOR.EARS_DEEP:  return palette.earsDeep;
      case COLOR.EYE_WHITE:  return palette.eyeWhite;
      case COLOR.PUPIL:      return palette.pupil;
      case COLOR.MOUTH:      return palette.mouth;
      case COLOR.SASH:       return palette.sash;
      case COLOR.SASH_SHADE: return palette.sashShade;
      case COLOR.OUTLINE:    return palette.outline;
      case COLOR.ACCENT:     return palette.accent;
      default:               return null;
    }
  };

  // Mood-driven body transform
  const transform = computeMoodTransform(mood, frame, size);

  // Trait modulates timing — applied as a frame multiplier (used inside composeGrid via mood frame)
  const isDead = mood === "dead";

  return (
    <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          display: "block",
          imageRendering: "pixelated",
          filter: isDead ? "grayscale(0.7) opacity(0.55)" : undefined,
          overflow: "visible",
        }}
      >
        {/* Soft drop shadow under feet */}
        <ellipse
          cx={size / 2}
          cy={size - cell * 0.5}
          rx={cell * 4}
          ry={cell * 0.8}
          fill="rgba(0,0,0,0.18)"
        />

        <g transform={transform}>
          {Array.from({ length: GRID * GRID }, (_, i) => {
            const x = i % GRID;
            const y = (i - x) / GRID;
            const c = grid[i];
            if (c === 0) return null;
            const fill = colorFor(c);
            if (!fill) return null;
            return (
              <rect
                key={i}
                x={x * cell}
                y={y * cell}
                width={cell + 0.5}
                height={cell + 0.5}
                fill={fill}
                shapeRendering="crispEdges"
              />
            );
          })}
        </g>
      </svg>
      {showName && (
        <div style={{ fontSize: 11, fontWeight: 700, color: palette.body, fontFamily: "Nunito, sans-serif" }}>
          {spec.name}
        </div>
      )}
    </div>
  );
}

function computeMoodTransform(mood: MoodName, frame: number, size: number): string {
  const cx = size / 2;
  const cy = size / 2;
  // Use px units in the transform; SVG width = size = 24 cells, so 1 cell = size/24.
  const cellPx = size / 24;
  switch (mood) {
    case "working": {
      // Fast, sharp typing motion: head jiggles left/right + small up bob
      const jx = Math.round(Math.sin(frame * 1.4) * cellPx * 0.4);
      const jy = -Math.round(Math.abs(Math.sin(frame * 0.7)) * cellPx * 0.6);
      const tilt = Math.sin(frame * 1.4) * 1.5;
      return `translate(${jx}, ${jy}) rotate(${tilt}, ${cx}, ${cy})`;
    }
    case "happy": {
      // Big bouncy hops
      const bob = Math.round(Math.abs(Math.sin(frame * 0.6)) * cellPx * 1.4);
      return `translate(0, ${-bob})`;
    }
    case "talking": {
      // Slow, deliberate head nod (forward and back rotation feel)
      const nod = Math.round(Math.sin(frame * 0.35) * cellPx * 0.5);
      const tilt = Math.sin(frame * 0.35) * 3;
      return `translate(0, ${nod}) rotate(${tilt}, ${cx}, ${cy})`;
    }
    case "skeptical": {
      // Long slow side-eye tilt, holds at extremes
      const tilt = Math.sin(frame * 0.12) * 4;
      return `rotate(${tilt}, ${cx}, ${cy})`;
    }
    case "idle": {
      // Truly chill — barely any movement, just slow breath
      const bob = Math.round(Math.sin(frame * 0.12) * cellPx * 0.2);
      return `translate(0, ${bob})`;
    }
    case "sleeping": {
      const bob = Math.round(Math.sin(frame * 0.08) * cellPx * 0.3);
      return `translate(0, ${bob})`;
    }
    default:
      return "translate(0, 0)";
  }
}
