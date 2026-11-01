import { chartMarks } from '../../platform/simpleChartModel';
import type { PanelRendererProps, TabularDataset } from '../../platform/types';
import { ChartBox, CHROME, fmt, linearScale, SERIES_COLORS, ticks, Warnings } from '../panels/PanelUi';

/** BI scatter keeps all series on one scale; generic Atlas scatter is unchanged. */
export function BiScatter({ dataset, panel, onEvent }: PanelRendererProps & { dataset: TabularDataset }) {
  const model = chartMarks(dataset, panel.mapping, 'scatter');
  const series = [...new Set(model.marks.map(mark => String(mark.row[panel.mapping.series] ?? 'Result')))];
  return <div className="flex h-full min-h-0 flex-col" data-panel-kind="scatter"><Warnings messages={[...model.errors, ...model.warnings]} />
    <ChartBox empty={model.errors.length ? 'Correct chart fields to display the analysis.' : !model.marks.length ? 'No numeric marks to display.' : undefined}>{({ width, height }) => {
      const x = linearScale([Math.min(...model.marks.map(mark => mark.x)), Math.max(...model.marks.map(mark => mark.x))], [54, width - 18]);
      const y = linearScale([Math.min(0, ...model.marks.map(mark => mark.y)), Math.max(0, ...model.marks.map(mark => mark.y))], [height - 32, 12]);
      return <svg width={width} height={height} role="img" aria-label={`${panel.title}: scatter`}>
        {ticks(...y.domain, 4).map(value => <g key={value}><line x1={54} x2={width - 18} y1={y.at(value)} y2={y.at(value)} stroke={CHROME.grid} /><text x={48} y={y.at(value) + 3} textAnchor="end" fontSize={10} fill={CHROME.textSecondary}>{fmt(value)}</text></g>)}
        {ticks(...x.domain, 4).map(value => <text key={value} x={x.at(value)} y={height - 10} textAnchor="middle" fontSize={10} fill={CHROME.textSecondary}>{model.xType === 'time' ? new Date(value).toISOString().slice(0, 10) : fmt(value)}</text>)}
        {model.marks.map((mark, index) => {
          const name = String(mark.row[panel.mapping.series] ?? 'Result'), label = `${name}, ${mark.label}: ${fmt(mark.y)}`;
          const activate = () => onEvent?.({ entity: 'mark', values: { ...mark.row, x: mark.x, y: mark.y } });
          return <circle key={index} cx={x.at(mark.x)} cy={y.at(mark.y)} r={4} fill={SERIES_COLORS[series.indexOf(name) % SERIES_COLORS.length]} tabIndex={0} role="button" aria-label={label} onClick={activate} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } }}><title>{label}</title></circle>;
        })}
      </svg>;
    }}</ChartBox>
    <div className="flex max-h-12 flex-wrap gap-3 overflow-auto text-xs" aria-label="Series legend">{series.map((name, index) => <span key={name}><span aria-hidden="true" style={{ color: SERIES_COLORS[index % SERIES_COLORS.length] }}>● </span>{name}</span>)}</div>
  </div>;
}
