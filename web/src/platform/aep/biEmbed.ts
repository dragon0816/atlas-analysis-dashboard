import type { BiAnalysis, BiCatalog, BiState } from './bi.ts';
import { parameterId } from './biDashboard.ts';
import type { VariableValues } from '../types';

export type EmbedState = 'loading' | 'ready' | 'waiting' | 'offline' | 'unknown_dashboard' | 'unknown_vault' | 'unknown_analysis' | 'invalid_link' | 'error';
export interface EmbedFeedStatus { state: 'ready' | 'offline' | 'unknown_vault' | 'error'; message?: string }

export function feedStatus(snapshot: { state: BiState; code?: string; message?: string }): EmbedFeedStatus {
  if (snapshot.state === 'ready' || snapshot.state === 'waiting') return { state: 'ready' };
  if (snapshot.code === 'vault_unknown') return { state: 'unknown_vault', message: snapshot.message };
  return { state: snapshot.state === 'error' ? 'error' : 'offline', message: snapshot.message };
}

/** One analysis as a catalog, so the shared reconcile manages only that panel. */
export function narrowCatalog(catalog: BiCatalog, slug: string): BiCatalog {
  return { ...catalog, order: catalog.order.filter(item => item === slug), analyses: catalog.analyses.filter(item => item.slug === slug) };
}

/** Turns URL text into typed variable values, or names the first problem. */
export function panelValues(analysis: BiAnalysis, params: Record<string, string>): { values: VariableValues } | { problem: string } {
  const values: VariableValues = {};
  for (const [name, text] of Object.entries(params)) {
    if (!Object.hasOwn(analysis.params, name)) return { problem: `“${analysis.slug}” has no parameter “${name}”.` };
    const param = analysis.params[name], id = parameterId(analysis.slug, name);
    if (param.type === 'bool') {
      if (text !== 'true' && text !== 'false') return { problem: `Parameter “${name}” must be true or false.` };
      values[id] = text === 'true';
    } else {
      if (param.type === 'enum' && !param.values!.includes(text)) return { problem: `Parameter “${name}” does not allow “${text}”.` };
      if (param.type === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(text) && Number.isFinite(Date.parse(text)))) return { problem: `Parameter “${name}” must be a date (YYYY-MM-DD).` };
      values[id] = text;
    }
  }
  return { values };
}

/** The most urgent feed state among a board's panels, from their dataset warnings. */
export function panelFeedState(warnings: string[][]): EmbedState {
  const all = warnings.flat(), has = (...states: string[]) => all.some(warning => states.some(state => warning.startsWith(`AEP BI ${state}:`)));
  return has('error') ? 'error' : has('offline', 'stale') ? 'offline' : has('waiting') ? 'waiting' : 'ready';
}

/** The parent's origin, which frame-ancestors already limits; null means do not post. */
export function embedTargetOrigin(location: { origin: string; ancestorOrigins?: ArrayLike<string> }, referrer: string): string | null {
  const ancestor = location.ancestorOrigins?.[0];
  if (ancestor && ancestor !== 'null') return ancestor;
  try {
    const origin = referrer ? new URL(referrer).origin : '';
    return origin && origin !== 'null' && origin !== location.origin ? origin : null;
  } catch { return null; }
}
