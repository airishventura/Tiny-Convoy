/**
 * Local persistence.
 *
 * Local storage is the primary store: the game must work fully offline and
 * without an account. Supabase, when configured, mirrors this — it never
 * becomes a requirement.
 */

const PREFIX = 'tinyconvoy:';

const available = (): boolean => {
  try {
    const k = `${PREFIX}__probe`;
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
};

const memory = new Map<string, string>();
const useMemory = typeof window === 'undefined' || !available();

export const load = <T,>(key: string, fallback: T): T => {
  try {
    const raw = useMemory ? memory.get(PREFIX + key) : localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

export const save = (key: string, value: unknown): void => {
  try {
    const raw = JSON.stringify(value);
    if (useMemory) memory.set(PREFIX + key, raw);
    else localStorage.setItem(PREFIX + key, raw);
  } catch {
    // Quota or private mode — losing a save is preferable to losing the run.
  }
};

export const remove = (key: string): void => {
  try {
    if (useMemory) memory.delete(PREFIX + key);
    else localStorage.removeItem(PREFIX + key);
  } catch {
    /* ignore */
  }
};

export const uid = (): string => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

/**
 * Player names are shown on a public board, so they are scrubbed on the way in:
 * control characters, bidi/zero-width tricks and markup punctuation all go.
 * The same function runs again server-side — this copy is a convenience, not a
 * security boundary.
 */
export const sanitizeName = (name: string): string => {
  let out = '';
  for (const ch of String(name)) {
    const c = ch.codePointAt(0) ?? 0;
    const isControl = c < 0x20 || (c >= 0x7f && c <= 0x9f);
    const isInvisible = (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0xfff9 && c <= 0xfffb);
    const isMarkup = '<>{}[]\\/`$"\''.includes(ch);
    if (isControl || isInvisible || isMarkup) continue;
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim().slice(0, 18);
};
