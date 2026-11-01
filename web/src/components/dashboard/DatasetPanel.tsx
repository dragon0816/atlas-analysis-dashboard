import type { PanelRendererProps } from "../../platform/types";
import { BasicPanel } from "../panels/BasicPanels";
import { HeatmapPanel } from "../panels/HeatmapPanel";
import { NetworkGraphPanel } from "../panels/NetworkGraphPanel";
import { SupplementalPanel } from "../panels/SupplementalPanel";
import { levelCounts } from '../../platform/aep/biDashboard';
import { BiScatter } from '../aep/BiScatter';

const basicTypes = new Set(["line", "mask", "bar", "box", "histogram", "stat", "gauge", "table"]);
const additionalTypes = new Set(["area", "pie", "donut", "scatter", "text", "status", "progress", "timeline"]);

/** Pure dataset renderer boundary. Sources and transforms belong to the dashboard runtime. */
export function DatasetPanel(props: PanelRendererProps) {
  if (props.panel.display.aepBi === true && props.dataset.kind === 'table') {
    const pending = props.dataset.meta.warnings.find(warning => /^AEP BI (waiting|offline|error):/.test(warning));
    if (pending && !props.dataset.rows.length) return <p role="status">{pending}</p>;
    const counts = levelCounts(props.dataset.rows);
    return <div className="flex h-full min-h-0 flex-col"><div className="flex gap-3 text-xs" aria-label="Analysis levels">{counts.gap > 0 && <span>gap: {counts.gap}</span>}{counts.warning > 0 && <span>warning: {counts.warning}</span>}</div><div className="min-h-0 flex-1">{props.panel.type === 'scatter' ? <BiScatter {...props} dataset={props.dataset} /> : <DatasetPanel {...props} panel={{ ...props.panel, display: { ...props.panel.display, aepBi: false } }} />}</div></div>;
  }
  if (props.panel.type === "network") return <NetworkGraphPanel {...props} />;
  if (props.panel.type === "heatmap") return <HeatmapPanel {...props} />;
  if (basicTypes.has(props.panel.type)) return <BasicPanel {...props} />;
  if (additionalTypes.has(props.panel.type)) return <SupplementalPanel {...props} />;
  return <p role="alert">Unknown panel type: {String(props.panel.type)}</p>;
}
