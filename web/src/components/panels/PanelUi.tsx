import { useEffect, useRef, useState, type ReactNode } from "react";

export const SERIES_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#fb923c", "#c084fc", "#a3e635"];
export const CHROME = { grid: "#273449", surface: "#0f172a", textPrimary: "#f1f5f9", textSecondary: "#b2c0d3", textMuted: "#8394ae", limit: "#fb7185" };

export function fmt(value: unknown, digits = 4): string {
  if (value === null || value === undefined) return "—";
  if (typeof value !== "number") return String(value);
  if (!Number.isFinite(value)) return "—";
  const precision = Math.max(1, Math.min(12, Math.trunc(digits)));
  if (value !== 0 && (Math.abs(value) >= 1e7 || Math.abs(value) < 1e-4)) return value.toExponential(Math.min(3, precision - 1));
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: precision }).format(value);
}
export function ellipsis(text: string, length = 24): string {
  const characters = [...String(text)];
  return characters.length > length ? `${characters.slice(0, Math.max(0, length - 1)).join("")}…` : text;
}
export function linearScale(bounds: [number, number], range: [number, number]) {
  let [min, max] = bounds;
  if (!Number.isFinite(min) || !Number.isFinite(max)) { min = 0; max = 1; }
  if (max < min) [min, max] = [max, min];
  if (min === max) {
    const offset = Math.max(1, Math.abs(min) * 0.05), low = min - offset, high = max + offset;
    min = Number.isFinite(low) ? low : min;
    max = Number.isFinite(high) ? high : max;
  }
  const span = max - min;
  return { domain: [min, max] as [number, number], at: (value: number) => range[0] + (Number.isFinite(span) ? (value - min) / span : (value / 2 - min / 2) / (max / 2 - min / 2)) * (range[1] - range[0]) };
}
export function ticks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const steps = Math.max(1, Math.min(12, Math.trunc(count) - 1));
  return Array.from({ length: steps + 1 }, (_, index) => min * (1 - index / steps) + max * (index / steps));
}

/** A standalone responsive viewport; no data provider or external chart runtime is involved. */
export function ChartBox({ children, empty }: { children: (size: { width: number; height: number }) => ReactNode; empty?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 260 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const width = Math.round(rect.width), height = Math.round(rect.height);
        setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
      }
    };
    measure();
    if (typeof ResizeObserver !== "undefined") { const observer = new ResizeObserver(measure); observer.observe(element); return () => observer.disconnect(); }
    window.addEventListener("resize", measure); return () => window.removeEventListener("resize", measure);
  }, []);
  return <div ref={host} className="relative min-h-0 flex-1 overflow-hidden" style={{ minHeight: 100 }}>
    {empty ? <p role="status" className="flex h-full items-center justify-center p-4 text-center text-xs text-slate-400">{empty}</p> : children(size)}
  </div>;
}

export function Tooltip({ x, y, width, title, rows }: { x: number; y: number; width: number; title: string; rows: { label: string; value: string }[] }) {
  const tooltipWidth = Math.min(220, Math.max(100, width - 16));
  return <div role="status" className="pointer-events-none absolute z-10 rounded border border-slate-600 bg-slate-950/95 p-2 text-xs shadow-xl" style={{ left: Math.max(4, Math.min(width - tooltipWidth - 4, x + 8)), top: Math.max(0, y - 60), width: tooltipWidth }}>
    <strong className="block truncate text-slate-100">{title}</strong>
    {rows.map((row, index) => <div key={index} className="flex justify-between gap-3 text-slate-300"><span className="truncate">{row.label}</span><span>{row.value}</span></div>)}
  </div>;
}

export function Warnings({ messages }: { messages: string[] }) {
  return <>{messages.map((message, index) => <p key={index} role="status" className="px-2 py-1 text-xs text-amber-300">{message}</p>)}</>;
}
