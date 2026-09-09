const ICON_POOL = ['🧩', '📦', '🚀', '🤖', '🧠', '🛰', '🧲', '🔧', '🔌', '📡', '🧾', '📚'];

/** Deterministic emoji for a name (no per-entity icon column). Same name → same icon. */
export function autoIcon(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return ICON_POOL[h % ICON_POOL.length];
}
