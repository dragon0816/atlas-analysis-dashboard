import type { BiCatalog } from './bi.ts';
import type { DashboardDocument, PanelDefinition, Row } from '../types';

export function analysisPanels(catalog: BiCatalog): PanelDefinition[] {
  return catalog.order.map((slug, index) => {
    const analysis = catalog.analyses.find(item => item.slug === slug)!;
    const mapping: Record<string, string> = {};
    for (const key of ['x', 'y', 'series'] as const) if (analysis.chart[key]) mapping[key] = analysis.chart[key]!;
    if (analysis.chart.type === 'bar') { mapping.category = mapping.x; mapping.value = mapping.y; }
    const params = Object.fromEntries(Object.keys(analysis.params).map(key => [key, `$${parameterId(slug, key)}`]));
    return { id: `bi-${slug}`, title: analysis.title, type: analysis.chart.type, datasource: { id: 'aep.bi.result' }, query: { vault: catalog.vault, slug, params }, mapping, transform: [], display: { aepBi: true }, layout: { x: index % 2 * 6, y: Math.floor(index / 2) * 8, w: 6, h: 8 } };
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
