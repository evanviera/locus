// Per-computer conveniences kept in localStorage. Everything shared lives in
// the board folder instead.

export const THEMES = ["dark", "graphite", "storm", "ash", "fog", "light"] as const;
export type Theme = (typeof THEMES)[number];
export const THEME_NAMES: Record<Theme, string> = {
  dark: "Dark", graphite: "Graphite", storm: "Storm", ash: "Ash", fog: "Fog", light: "Light"
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export const prefs = {
  theme: () => read<Theme>("locus:theme", "dark"),
  setTheme: (t: Theme) => write("locus:theme", t),
  recent: () => read<string[]>("locus:recent", []),
  addRecent(root: string) {
    write("locus:recent", [root, ...prefs.recent().filter((r) => r !== root)].slice(0, 8));
  },
  sidebar: () => read<boolean>("locus:sidebar", true),
  setSidebar: (v: boolean) => write("locus:sidebar", v)
};

export function applyTheme(t: Theme) {
  if (t === "dark") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
}
