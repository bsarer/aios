import type { Theme } from '@aios/shared/protocol';

/** First key present wins. Covers Omarchy/alacritty-style names; unknown themes keep the defaults. */
const MAP: Record<string, string[]> = {
  '--bg': ['background', 'primary.background', 'colors.primary.background', 'bg'],
  '--fg': ['foreground', 'primary.foreground', 'colors.primary.foreground', 'fg'],
  '--accent': ['accent', 'normal.blue', 'colors.normal.blue', 'color4', 'blue'],
  '--danger': ['normal.red', 'colors.normal.red', 'color1', 'red'],
  '--warning': ['normal.yellow', 'colors.normal.yellow', 'color3', 'yellow'],
};

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  for (const [cssVar, keys] of Object.entries(MAP)) {
    const value = keys.map((k) => theme[k]).find(Boolean);
    if (value) root.style.setProperty(cssVar, value);
    else root.style.removeProperty(cssVar);
  }
}
