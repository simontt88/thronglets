const PREFIX = ["no", "ki", "ta", "ru", "ve", "xo", "mi", "pa", "lu", "fe", "bo", "ny", "za", "qu", "hi", "do"];
const MID = ["", "", "k", "l", "n", "r", "s", "v"];
const SUFFIX = ["lo", "mi", "ta", "xi", "no", "ru", "va", "py", "ka", "do", "fi", "zu"];

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function pickName(seed: number): string {
  const p = PREFIX[seed % PREFIX.length];
  const m = MID[(seed >>> 4) % MID.length];
  const s = SUFFIX[(seed >>> 8) % SUFFIX.length];
  const raw = p + m + s;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function generateUniqueName(existingNames: string[]): string {
  const taken = new Set(existingNames.map((n) => n.toLowerCase()));
  for (let attempt = 0; attempt < 100; attempt++) {
    const salt = Date.now() ^ (Math.random() * 0xffffffff) ^ (attempt * 7919);
    const name = pickName(salt >>> 0);
    if (!taken.has(name.toLowerCase())) return name;
  }
  const base = pickName(fnv1a(`${Date.now()}-${Math.random()}`));
  return `${base}-${Math.floor(Math.random() * 99)}`;
}
