import type { GridLayout, PanelDefinition } from "./types";

export const GRID_COLUMNS = 12;
export const GRID_ROW = 36;
export const GRID_GAP = 12;
export function overlaps(a: GridLayout, b: GridLayout): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
export function clampLayout(layout: GridLayout, columns = GRID_COLUMNS): GridLayout {
  const integer = (n: number, fallback: number) => Number.isFinite(n) ? Math.round(n) : fallback;
  const minW = Math.min(columns, Math.max(1, integer(layout.minW ?? 2, 2)));
  const minH = Math.max(2, Math.min(30, integer(layout.minH ?? 3, 3)));
  const w = Math.min(columns, Math.max(minW, integer(layout.w, 6)));
  return { ...layout, minW, minH, w, h: Math.max(minH, Math.min(40, integer(layout.h, 6))), x: Math.max(0, Math.min(columns - w, integer(layout.x, 0))), y: Math.max(0, Math.min(10000, integer(layout.y, 0))) };
}
/** The explicitly moved panel wins; other panels move down deterministically. */
export function settlePanels(panels: PanelDefinition[], movedId?: string, columns = GRID_COLUMNS): PanelDefinition[] {
  const placed = new Map<string, GridLayout>();
  const ordered = movedId ? [...panels.filter(p => p.id === movedId), ...panels.filter(p => p.id !== movedId)] : panels;
  for (const panel of ordered) {
    const layout = clampLayout(panel.layout, columns);
    let attempts = 0;
    while ([...placed.values()].some(other => overlaps(layout, other))) {
      layout.y++;
      if (++attempts > 20000) throw new Error("Dashboard layout is too large");
    }
    placed.set(panel.id, layout);
  }
  return panels.map(p => ({ ...p, layout: placed.get(p.id)! }));
}
export function responsivePanels(panels: PanelDefinition[], columns: number): PanelDefinition[] {
  if (columns === GRID_COLUMNS) return settlePanels(panels);
  const adapted = panels.map(p => ({ ...p, layout: { ...p.layout, x: columns === 1 ? 0 : Math.floor(p.layout.x * columns / GRID_COLUMNS), w: columns === 1 ? 1 : Math.max(2, Math.round(p.layout.w * columns / GRID_COLUMNS)) } }));
  return settlePanels(adapted, undefined, columns);
}
export function nextPanelLayout(panels: PanelDefinition[], w = 6, h = 7): GridLayout {
  for (let y = 0; y < 20000; y++) for (let x = 0; x <= GRID_COLUMNS - w; x++) {
    const candidate = { x, y, w, h, minW: 2, minH: 3 };
    if (panels.every(p => !overlaps(candidate, p.layout))) return candidate;
  }
  throw new Error("Dashboard layout is full");
}
