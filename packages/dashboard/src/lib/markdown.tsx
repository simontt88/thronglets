import React from "react";

export function renderMarkdown(text: string): React.ReactNode {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={elements.length} className="md-code-block">
          {lang && <span className="md-code-lang">{lang}</span>}
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Table detection
    if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
      const tableLines: string[] = [line];
      i++;
      while (i < lines.length && lines[i].includes("|")) {
        tableLines.push(lines[i]);
        i++;
      }
      elements.push(<MdTable key={elements.length} lines={tableLines} />);
      continue;
    }

    // Headers
    if (line.startsWith("### ")) {
      elements.push(<h4 key={elements.length} className="md-h3">{inlineFormat(line.slice(4))}</h4>);
      i++; continue;
    }
    if (line.startsWith("## ")) {
      elements.push(<h3 key={elements.length} className="md-h2">{inlineFormat(line.slice(3))}</h3>);
      i++; continue;
    }
    if (line.startsWith("# ")) {
      elements.push(<h2 key={elements.length} className="md-h1">{inlineFormat(line.slice(2))}</h2>);
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={elements.length} className="md-hr" />);
      i++; continue;
    }

    // List items
    if (/^\s*[-*]\s/.test(line)) {
      elements.push(<div key={elements.length} className="md-li">{inlineFormat(line.replace(/^\s*[-*]\s/, ""))}</div>);
      i++; continue;
    }

    // Numbered list
    if (/^\s*\d+\.\s/.test(line)) {
      elements.push(<div key={elements.length} className="md-li">{inlineFormat(line.replace(/^\s*\d+\.\s/, ""))}</div>);
      i++; continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={elements.length} className="md-spacer"></div>);
      i++; continue;
    }

    // Normal paragraph
    elements.push(<p key={elements.length} className="md-p">{inlineFormat(line)}</p>);
    i++;
  }

  return <>{elements}</>;
}

function inlineFormat(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Inline code
    const codeMatch = remaining.match(/^(.*?)`([^`]+)`(.*)$/);
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<span key={key++}>{codeMatch[1]}</span>);
      parts.push(<code key={key++} className="md-inline-code">{codeMatch[2]}</code>);
      remaining = codeMatch[3];
      continue;
    }

    // Bold
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)$/);
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<span key={key++}>{boldMatch[1]}</span>);
      parts.push(<strong key={key++}>{boldMatch[2]}</strong>);
      remaining = boldMatch[3];
      continue;
    }

    // Image ![alt](url)
    const imgMatch = remaining.match(/^(.*?)!\[([^\]]*)\]\(([^)]+)\)(.*)$/);
    if (imgMatch) {
      if (imgMatch[1]) parts.push(<span key={key++}>{imgMatch[1]}</span>);
      parts.push(
        <span key={key++} className="md-img-wrap">
          <img className="md-img" src={imgMatch[3]} alt={imgMatch[2]} loading="lazy" />
        </span>
      );
      remaining = imgMatch[4];
      continue;
    }

    // Link [text](url)
    const linkMatch = remaining.match(/^(.*?)\[([^\]]+)\]\(([^)]+)\)(.*)$/);
    if (linkMatch) {
      if (linkMatch[1]) parts.push(<span key={key++}>{linkMatch[1]}</span>);
      parts.push(<a key={key++} className="md-link" href={linkMatch[3]} target="_blank" rel="noopener">{linkMatch[2]}</a>);
      remaining = linkMatch[4];
      continue;
    }

    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function MdTable({ lines }: { lines: string[] }) {
  const parseRow = (line: string) =>
    line.split("|").map((c) => c.trim()).filter((c) => c.length > 0);

  const header = parseRow(lines[0]);
  const rows = lines.slice(2).map(parseRow);

  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>{header.map((h, i) => <th key={i}>{inlineFormat(h)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{inlineFormat(cell)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
