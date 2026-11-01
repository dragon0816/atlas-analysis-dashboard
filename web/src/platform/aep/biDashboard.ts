import type { BiCatalog } from './bi.ts';
import type { DashboardDocument, PanelDefinition, Row } from '../types';

export function analysisPanels(catalog: BiCatalog): PanelDefinition[] {
  return catalog.order.map((slug, index) => {
    const analysis = catalog.analyses.find(item => item.slug === slug)!;
    const mapping: Record<string, string> = {};
    for (const key of ['x', 'y', 'series'] as const) if (analysis.chart[key]) mapping[key] = analysis.chart[key]!;
    if (analysis.chart.type === 'bar') { mapping.category = mapping.x; mapping.value = mapping.y; }
    const params = Object.fromEntries(Object.keys(analysis.params).map(key => [key, `$${parameterId(slug, key)}`]));
    return { id: `bi-${slug}`, title: analysis.title, type: analysis.chart.type, datasource: { id: 'aep.bi.result' }, query: { vault: catalog.vault, slug, params, digest: analysis.digest }, mapping, transform: [], display: { aepBi: true, aepBiQuestion: analysis.question }, layout: { x: index % 2 * 6, y: Math.floor(index / 2) * 8, w: 6, h: 8 } };
  });
}
export function parameterId(slug: string, name: string) {
  const encode = (text: string) => [...text].map(character => character.codePointAt(0)!.toString(16)).join('-');
  return `bi.${encode(slug)}.${encode(name)}`;
}
export function biDashboard(catalog: BiCatalog): DashboardDocument {
  return { schemaVersion: 2, id: `aep-bi-${catalog.vault}`, title: 'AEP BI', applicationId: 'aep_bi', variables: catalog.order.flatMap(slug => {
    const analysis = catalog.analyses.find(item => item.slug === slug)!;
    return Object.entries(analysis.params).map(([name, param]) => ({ id: parameterId(slug, name), label: `${analysis.title} · ${name}`, default: param.default, type: param.type === 'bool' ? 'boolean' as const : 'string' as const }));
  }), values: { 'bi:vault': catalog.vault }, panels: analysisPanels(catalog) };
}
export function levelCounts(rows: Row[]) { return { gap: rows.filter(row => row.level === 'gap').length, warning: rows.filter(row => row.level === 'warning').length }; }

/** Reconcile producer-owned analysis metadata while retaining personal panel geometry. */
export function reconcileBiDashboard(board: DashboardDocument, values: import('../types').VariableValues, catalog: BiCatalog): DashboardDocument {
  const generated = biDashboard(catalog), definitions = new Map(generated.panels.map(panel => [String(panel.query!.slug), panel]));
  const seen = new Set<string>();
  let variables = [...board.variables];
  const nextValues = { ...values };
  const clearParameters = (slug: string) => {
    const prefix = parameterId(slug, '');
    variables = variables.filter(variable => !variable.id.startsWith(prefix));
    for (const id of Object.keys(nextValues)) if (id.startsWith(prefix)) delete nextValues[id];
  };
  const installParameters = (slug: string) => {
    const analysis = catalog.analyses.find(item => item.slug === slug)!;
    const previous = Object.fromEntries(board.variables.map(variable => [variable.id, variable.default]));
    clearParameters(slug);
    for (const [name, param] of Object.entries(analysis.params)) {
      const id = parameterId(slug, name), candidate = values[id] ?? previous[id];
      const valid = param.type === 'enum' ? typeof candidate === 'string' && param.values!.includes(candidate)
        : param.type === 'bool' ? typeof candidate === 'boolean'
        : typeof candidate === 'string' && (param.type !== 'date' || /^\d{4}-\d{2}-\d{2}$/.test(candidate) && Number.isFinite(Date.parse(candidate)));
      nextValues[id] = valid ? candidate! : param.default;
      variables.push(generated.variables.find(variable => variable.id === id)!);
    }
  };
  const panels = board.panels.flatMap(panel => {
    if (panel.datasource.id !== 'aep.bi.result' || panel.query?.vault !== catalog.vault || typeof panel.query.slug !== 'string') return [panel];
    const slug = panel.query.slug, next = definitions.get(slug);
    if (!next) { clearParameters(slug); return []; }
    seen.add(slug);
    if (panel.query.digest === next.query!.digest) return [panel];
    installParameters(slug);
    return [{ ...panel, title: next.title, type: next.type, mapping: next.mapping, query: { ...panel.query, ...next.query }, display: { ...panel.display, ...next.display } }];
  });
  for (const next of generated.panels) {
    const slug = String(next.query!.slug);
    if (seen.has(slug)) continue;
    installParameters(slug);
    const y = panels.reduce((bottom, panel) => Math.max(bottom, panel.layout.y + panel.layout.h), 0);
    panels.push({ ...next, layout: board.panels.length ? { ...next.layout, x: 0, y } : next.layout });
  }
  if (panels.length === board.panels.length && panels.every((panel, index) => panel === board.panels[index])) return board;
  return { ...board, variables, values: nextValues, panels };
}
