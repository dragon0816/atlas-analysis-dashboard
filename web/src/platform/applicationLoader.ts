import { parse } from "yaml";
import type { ApplicationDefinition, DashboardDocument, SourceDefinition, TransformStep } from "./types";
import { parseDashboardDocument } from "./documents";

export function readApplicationPackages(files: Record<string, string>): { applications: ApplicationDefinition[]; errors: string[] } {
  const applications: ApplicationDefinition[] = [];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const [filename, content] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    if (!filename.endsWith("/application.yaml")) continue;
    try {
      const root = filename.slice(0, filename.lastIndexOf("/") + 1);
      const read = (relative: string): string => {
        if (!relative || relative.startsWith("/") || relative.includes("\\") || relative.split("/").includes("..")) throw new Error("Application asset must stay within its package");
        const raw = files[root + relative];
        if (raw === undefined) throw new Error(`Missing application asset: ${relative}`);
        if (raw.length > 2_000_000) throw new Error(`Application asset exceeds 2 MB: ${relative}`);
        return raw;
      };
      const manifest = parse(content) as Record<string, unknown>;
      if (!manifest || typeof manifest.id !== "string" || !/^[a-zA-Z0-9_.-]+$/.test(manifest.id) || typeof manifest.name !== "string") throw new Error("Application requires a valid id and name");
      if (ids.has(manifest.id)) throw new Error(`Duplicate application id: ${manifest.id}`);
      const sourceFile = String(manifest.datasources ?? "datasources.yaml");
      const sources = parse(read(sourceFile)) as Record<string, SourceDefinition>;
      if (!sources || typeof sources !== "object" || Array.isArray(sources)) throw new Error("Expected datasource mapping");
      for (const source of Object.values(sources)) {
        if (!source || typeof source !== "object") throw new Error("Invalid source definition");
        if (source.path) {
          const raw = read(source.path);
          source.data = source.type === "csv" ? raw : source.path.endsWith(".json") ? JSON.parse(raw) : parse(raw);
        }
      }
      const transforms = manifest.transforms ? parse(read(String(manifest.transforms))) as Record<string, TransformStep[]> : {};
      if (!Array.isArray(manifest.dashboards) || !manifest.dashboards.length) throw new Error("Application requires dashboard presets");
      const dashboards: DashboardDocument[] = manifest.dashboards.map(path => {
        const board = parseDashboardDocument(parse(read(String(path))));
        if (board.applicationId !== manifest.id) throw new Error("Dashboard applicationId does not match its package");
        for (const panel of board.panels) if (!Object.hasOwn(sources, panel.datasource.id)) throw new Error(`Unknown datasource: ${panel.datasource.id}`);
        return board;
      });
      applications.push({ id: manifest.id, name: manifest.name, description: String(manifest.description ?? ""), demo: manifest.demo === true, default: manifest.default === true, sources, transforms, dashboards });
      ids.add(manifest.id);
    } catch (error) { errors.push(`${filename.split("/").slice(-2).join("/")}: ${String(error)}`); }
  }
  return { applications, errors };
}
