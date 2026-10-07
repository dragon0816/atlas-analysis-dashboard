import type { PanelAction, PanelEvent, VariableValues } from "./types";

export function actionValues(action: PanelAction, event: PanelEvent): Record<string, unknown> {
  return Object.fromEntries(Object.entries(action.values ?? {}).map(([key, value]) => [key, typeof value === "string" && value.startsWith("$") ? event.values[value.slice(1)] ?? null : value]));
}
export function applyFilterAction(current: VariableValues, action: PanelAction, event: PanelEvent, allowed: string[]): VariableValues {
  const next = { ...current };
  for (const [key, value] of Object.entries(actionValues(action, event))) {
    if (!allowed.includes(key)) throw new Error(`Unknown dashboard variable: ${key}`);
    if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) || Array.isArray(value) && value.every(v => typeof v === "string")) next[key] = value;
    else throw new Error(`Unsupported value for variable: ${key}`);
  }
  return next;
}
export function safeLink(input: string, base = "https://localhost/"): string {
  const url = new URL(input, base);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Links require HTTP(S) without embedded credentials");
  return url.href;
}
