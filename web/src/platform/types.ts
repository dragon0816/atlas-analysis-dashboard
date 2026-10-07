export type FieldType = "number" | "string" | "boolean" | "time" | "other";
export interface FieldLimits { lower: number | null; upper: number | null }
export type PanelKind = "line" | "mask" | "bar" | "box" | "histogram" | "stat" | "gauge" | "table";

export type Row = Record<string, unknown>;
export interface DatasetField { name: string; type: FieldType; unit?: string | null; limits?: FieldLimits | null }
export interface DatasetMeta { warnings: string[]; truncated: boolean; sourceRows: number; revision?: string }
export interface TabularDataset { kind: "table"; fields: DatasetField[]; rows: Row[]; meta: DatasetMeta }
export interface GraphDataset { kind: "graph"; nodes: Row[]; edges: Row[]; meta: DatasetMeta }
export type Dataset = TabularDataset | GraphDataset;
export type PlatformPanelKind = PanelKind | "heatmap" | "network" | "area" | "pie" | "donut" | "scatter" | "text" | "status" | "progress" | "timeline";
export interface GridLayout { x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export interface TransformStep { op: string; [key: string]: unknown }
export type VariableValue = string | number | boolean | null | string[];
export type VariableValues = Record<string, VariableValue>;
export interface VariableDefinition { id: string; label?: string; type?: "string" | "number" | "boolean" | "time_range"; default?: VariableValue; options?: (string | number)[] }
export type ActionKind = "set_filter" | "open_details" | "navigate" | "drill_down" | "highlight" | "open_link";
export interface PanelAction { action: ActionKind; target?: string; url?: string; values?: Record<string, unknown> }
export interface PanelInteraction { on_click?: PanelAction | PanelAction[] }
export interface PanelDefinition {
  id: string; title: string; type: PlatformPanelKind; datasource: { id: string };
  query?: Row; transform: TransformStep[]; mapping: Record<string, string>;
  display: Row; interaction?: PanelInteraction; layout: GridLayout; refresh?: number;
}
export interface DashboardDocument {
  schemaVersion: 2; id: string; title: string; applicationId: string;
  description?: string; presetId?: string; variables: VariableDefinition[];
  values?: VariableValues; panels: PanelDefinition[];
}
export interface SourceDefinition {
  type: "json" | "csv" | "rest" | "websocket" | "custom";
  label?: string; data?: unknown; path?: string; url?: string;
  format?: "table" | "graph"; fields?: DatasetField[];
  provider?: string; query?: Row;
  /** Row field to dashboard variable name. Unbound variables do not filter. */
  bindings?: Record<string, string>;
  maxRows?: number; refresh?: number;
}
export interface ApplicationDefinition {
  id: string; name: string; description?: string; demo?: boolean; default?: boolean;
  sources: Record<string, SourceDefinition>;
  transforms: Record<string, TransformStep[]>;
  dashboards: DashboardDocument[];
}
export interface PanelEvent { entity: "cell" | "node" | "edge" | "row" | "mark"; values: Row }
export interface PanelRendererProps { dataset: Dataset; panel: PanelDefinition; onEvent?: (event: PanelEvent) => void }
