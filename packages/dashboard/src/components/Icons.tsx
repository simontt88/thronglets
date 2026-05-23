const SC = "currentColor";

export function Icon({ name, size = 14 }: { name: string; size?: number }) {
  const base = { width: size, height: size, viewBox: "0 0 16 16", fill: "none", xmlns: "http://www.w3.org/2000/svg", style: { display: "block" as const, flexShrink: 0 } };
  const sw = 1.8;
  const lc = "round" as const;
  const lj = "round" as const;

  switch (name) {
    case "plus":
      return <svg {...base}><path d="M8 3v10M3 8h10" stroke={SC} strokeWidth={sw} strokeLinecap={lc}/></svg>;
    case "x":
      return <svg {...base}><path d="M4 4l8 8M12 4l-8 8" stroke={SC} strokeWidth={sw} strokeLinecap={lc}/></svg>;
    case "search":
      return <svg {...base}><circle cx="7" cy="7" r="4" stroke={SC} strokeWidth={sw}/><path d="M10.2 10.2 13 13" stroke={SC} strokeWidth={sw} strokeLinecap={lc}/></svg>;
    case "sparkle":
      return <svg {...base}><path d="M8 2 L9.3 6.7 L14 8 L9.3 9.3 L8 14 L6.7 9.3 L2 8 L6.7 6.7 Z" stroke={SC} strokeWidth={sw} strokeLinejoin={lj} fill={SC} fillOpacity={0.12}/></svg>;
    case "settings":
      return <svg {...base}><circle cx="8" cy="8" r="2" stroke={SC} strokeWidth={sw}/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.5 3.5l1.4 1.4M11.1 11.1l1.4 1.4M3.5 12.5l1.4-1.4M11.1 4.9l1.4-1.4" stroke={SC} strokeWidth={sw} strokeLinecap={lc}/></svg>;
    case "send":
      return <svg {...base}><path d="M2.5 8 13.5 3 11 13.5 8 9 2.5 8Z" stroke={SC} strokeWidth={sw} strokeLinejoin={lj} fill={SC} fillOpacity={0.12}/></svg>;
    case "dots":
      return <svg {...base}><circle cx="4" cy="8" r="1.3" fill={SC}/><circle cx="8" cy="8" r="1.3" fill={SC}/><circle cx="12" cy="8" r="1.3" fill={SC}/></svg>;
    case "panel":
      return <svg {...base}><rect x="2.5" y="3.5" width="11" height="9" rx="1.5" stroke={SC} strokeWidth={sw}/><path d="M6 3.5v9" stroke={SC} strokeWidth={sw}/></svg>;
    case "dispatch":
      return <svg {...base}><circle cx="8" cy="8" r="2.5" stroke={SC} strokeWidth={sw}/><path d="M8 2v3M8 11v3M2 8h3M11 8h3" stroke={SC} strokeWidth={sw} strokeLinecap={lc}/></svg>;
    case "trash":
      return <svg {...base}><path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 4.5l.7 8.5h4.6L11 4.5" stroke={SC} strokeWidth={sw} strokeLinecap={lc} strokeLinejoin={lj}/></svg>;
    case "stop":
      return <svg {...base}><rect x="4" y="4" width="8" height="8" rx="1.5" stroke={SC} strokeWidth={sw} fill={SC} fillOpacity={0.12}/></svg>;
    case "check":
      return <svg {...base}><path d="M3 8.5 6.5 12 13 4.5" stroke={SC} strokeWidth={sw} strokeLinecap={lc} strokeLinejoin={lj}/></svg>;
    case "pencil":
      return <svg {...base}><path d="m3 13 1-3 7-7 2 2-7 7-3 1Z" stroke={SC} strokeWidth={sw} strokeLinejoin={lj}/></svg>;
    case "paint":
      return <svg {...base}><circle cx="8" cy="8" r="5.5" stroke={SC} strokeWidth={sw}/><circle cx="5.5" cy="6.5" r="1" fill={SC}/><circle cx="10.5" cy="6.5" r="1" fill={SC}/><circle cx="6.5" cy="10.5" r="1" fill={SC}/><circle cx="10.5" cy="10.5" r="1" fill={SC}/></svg>;
    default: return null;
  }
}
