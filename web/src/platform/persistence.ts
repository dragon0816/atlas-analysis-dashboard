import type { DashboardDocument } from "./types";
import { parseDashboardDocument } from "./documents";

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  let message = `${response.status} ${response.statusText}`;
  try { const error = await response.json(); message = String(error.detail?.message ?? error.detail ?? message); } catch { /* Preserve the HTTP error. */ }
  throw new Error(message);
}
export async function savedDashboardNames(signal?: AbortSignal): Promise<string[]> {
  return (await checked(await fetch("/dashboards", { signal }))).json();
}
export async function loadDashboard(name: string, signal?: AbortSignal): Promise<{ document: DashboardDocument; revision: string | null }> {
  const response = await checked(await fetch(`/dashboards/${encodeURIComponent(name)}`, { signal }));
  return { document: parseDashboardDocument(await response.json()), revision: response.headers.get("ETag") };
}
export async function persistDashboard(name: string, document: DashboardDocument, revision: string | null, create: boolean): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (create) headers["If-None-Match"] = "*";
  else if (revision) headers["If-Match"] = revision;
  else throw new Error("Reload this dashboard before saving: its revision is unavailable");
  const response = await checked(await fetch(`/dashboards/${encodeURIComponent(name)}`, { method: "PUT", headers, body: JSON.stringify(document) }));
  return response.headers.get("ETag");
}
