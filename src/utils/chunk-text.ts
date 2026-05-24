/**
 * Split text into chunks at newline boundaries, falling back to hard split
 * when no suitable newline is found in the first half of the chunk.
 */
export function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let idx = remaining.lastIndexOf("\n", maxLen);
    if (idx < maxLen * 0.5) idx = maxLen;
    chunks.push(remaining.slice(0, idx));
    remaining = remaining.slice(idx);
  }
  return chunks;
}
