import type { PanelRendererProps } from "../../platform/types";
import { BasicPanel } from "../panels/BasicPanels";
import { HeatmapPanel } from "../panels/HeatmapPanel";
import { NetworkGraphPanel } from "../panels/NetworkGraphPanel";
import { SupplementalPanel } from "../panels/SupplementalPanel";

const basicTypes = new Set(["line", "mask", "bar", "box", "histogram", "stat", "gauge", "table"]);
const additionalTypes = new Set(["area", "pie", "donut", "scatter", "text", "status", "progress", "timeline"]);

/** Pure dataset renderer boundary. Sources and transforms belong to the dashboard runtime. */
export function DatasetPanel(props: PanelRendererProps) {
  if (props.panel.type === "network") return <NetworkGraphPanel {...props} />;
  if (props.panel.type === "heatmap") return <HeatmapPanel {...props} />;
  if (basicTypes.has(props.panel.type)) return <BasicPanel {...props} />;
  if (additionalTypes.has(props.panel.type)) return <SupplementalPanel {...props} />;
  return <p role="alert">Unknown panel type: {String(props.panel.type)}</p>;
}
