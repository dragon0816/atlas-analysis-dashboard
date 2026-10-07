import { checkAbort, isRecord } from "./dataset.ts";
import { SourceRegistry, type DatasetObserver, type RuntimeDependencies, type SourceProvider } from "./sources.ts";
import { executePipeline, filterDataset, filterTimeRangeDataset, resolveVariables } from "./transforms.ts";
import type { ApplicationDefinition, Dataset, PanelDefinition, Row, VariableValues, VariableDefinition } from "./types";
export type { DatasetObserver, RuntimeDependencies, SourceProvider } from "./sources";
/** Pure panel preprocessing on top of an application-scoped, shared source registry. */
export class PlatformRuntime {
  readonly sources: SourceRegistry;
  private app: ApplicationDefinition;
  private disposed = false;
  private variableDefinitions: () => VariableDefinition[];
  constructor(app: ApplicationDefinition, deps: RuntimeDependencies = {}) { this.app = app; this.sources = new SourceRegistry(app, deps); const definitions = deps.variableDefinitions; this.variableDefinitions = typeof definitions === "function" ? definitions : () => definitions ?? app.dashboards.flatMap(d => d.variables); }
  invalidate(sourceId?: string) { this.sources.invalidate(sourceId); }
  registerProvider(id: string, provider: SourceProvider) { this.sources.registerProvider(id, provider); }
  private sourceQuery(id: string, query: Row, variables: VariableValues): Row {
    return resolveVariables({ ...(this.sources.definition(id).query ?? {}), ...query }, variables) as Row;
  }
  private queryFor(panel: PanelDefinition, variables: VariableValues): Row {
    return this.sourceQuery(panel.datasource.id, panel.query ?? {}, variables);
  }
  private prepare(id: string, dataset: Dataset, variables: VariableValues, query: Row, graphMapping: Record<string, string> = {}): Dataset {
    const definition = this.sources.definition(id);
    const timeVariables = new Set(this.variableDefinitions().filter(v => v.type === "time_range").map(v => v.id));
    query = this.sourceQuery(id, query, variables);
    const where = Object.fromEntries(Object.entries(definition.bindings ?? {}).filter(([, variable]) => !timeVariables.has(variable) && Object.hasOwn(variables, variable)).map(([field, variable]) => [field, variables[variable]]).filter(([, value]) => value !== null && value !== "" && value !== "*" && !(Array.isArray(value) && !value.length)));
    let data = Object.keys(where).length ? filterDataset(dataset, where, dataset.kind === "graph", graphMapping) : dataset;
    for (const [field, variable] of Object.entries(definition.bindings ?? {})) {
      const value = variables[variable];
      if (timeVariables.has(variable) && value !== undefined && value !== null && value !== "" && value !== "*") data = filterTimeRangeDataset(data, field, value, graphMapping);
    }
    if (isRecord(query.filter)) data = filterDataset(data, query.filter, false, graphMapping);
    if (Array.isArray(query.fields)) {
      if (data.kind !== "table") throw new Error("Field projection requires tabular data");
      const current = data, names = query.fields as string[];
      for (const name of names) if (!current.fields.some(f => f.name === name)) throw new Error(`Projection field unavailable: ${name}`);
      data = { ...current, fields: names.map(name => current.fields.find(f => f.name === name)!), rows: current.rows.map(row => Object.fromEntries(names.map(name => [name, row[name]]))) };
    }
    if (query.max_rows !== undefined) {
      if (!Number.isSafeInteger(query.max_rows) || Number(query.max_rows) < 1 || Number(query.max_rows) > 20000) throw new Error("Invalid query.max_rows");
      if (data.kind !== "table") throw new Error("query.max_rows requires tabular data");
      const truncated = data.rows.length > Number(query.max_rows);
      data = { ...data, rows: data.rows.slice(0, Number(query.max_rows)), meta: { ...data.meta, truncated: data.meta.truncated || truncated, warnings: truncated ? [...data.meta.warnings, "Query row limit reached"] : data.meta.warnings } };
    }
    return data;
  }
  private async transform(panel: PanelDefinition, variables: VariableValues, data: Dataset, signal?: AbortSignal) {
    return executePipeline(this.prepare(panel.datasource.id, data, variables, this.queryFor(panel, variables), panel.mapping), panel.transform, {
      variables, signal, transforms: this.app.transforms, graphMapping: panel.mapping,
      getSource: async (id, query = {}) => { const effective = this.sourceQuery(id, query, variables); return this.prepare(id, await this.sources.query(id, effective, signal), variables, effective); },
    });
  }
  async query(panel: PanelDefinition, variables: VariableValues = {}, signal?: AbortSignal): Promise<Dataset> {
    checkAbort(signal); const data = await this.sources.query(panel.datasource.id, this.queryFor(panel, variables), signal); return this.transform(panel, variables, data, signal);
  }
  subscribe(panel: PanelDefinition, variables: VariableValues, observer: DatasetObserver, signal?: AbortSignal): () => void {
    checkAbort(signal); const controller = new AbortController(); let generation = 0, stopped = false;
    const abort = () => stop();
    const unsubscribe = this.sources.subscribe(panel.datasource.id, this.queryFor(panel, variables), {
      next: data => { const current = ++generation; void this.transform(panel, variables, data, controller.signal).then(value => { if (!stopped && !this.disposed && current === generation) observer.next(value); }, ex => { if (!stopped && !this.disposed && current === generation) observer.error(ex instanceof Error ? ex : new Error(String(ex))); }); },
      error: ex => { if (!stopped && !this.disposed) observer.error(ex); }, complete: () => { if (!stopped && !this.disposed) observer.complete?.(); },
    }, controller.signal);
    const stop = () => { if (stopped) return; stopped = true; generation++; controller.abort(); unsubscribe(); signal?.removeEventListener("abort", abort); };
    signal?.addEventListener("abort", abort, { once: true }); if (signal?.aborted) stop(); return stop;
  }
  dispose() { this.disposed = true; this.sources.dispose(); }
}
