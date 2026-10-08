import type { Row } from "../../platform/types";
import { heatmapColor, heatmapFraction } from "../../platform/heatmapModel";

type RGB = [number, number, number];

/** Opaque hex only: alpha is controlled separately and SVG paint URLs are never accepted. */
export function normalizeHexColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return undefined;
  const digits = match[1].toLowerCase();
  return `#${digits.length === 3 ? [...digits].map(digit => digit + digit).join("") : digits}`;
}

/** Preserve zero; reject nonnumeric and nonfinite imported settings. */
export function panelFillOpacity(display: Row): number {
  return typeof display.fillOpacity === "number" && Number.isFinite(display.fillOpacity)
    ? Math.max(0, Math.min(1, display.fillOpacity)) : 1;
}

function channels(color: string): RGB {
  const hex = normalizeHexColor(color);
  if (hex) return [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16)) as RGB;
  const rgb = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(color);
  return rgb ? rgb.slice(1).map(Number) as RGB : [15, 23, 42];
}
const rgbColor = (rgb: RGB) => `rgb(${rgb.join(", ")})`;
const hexColor = (rgb: RGB) => `#${rgb.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
const mix = (low: RGB, high: RGB, fraction: number): RGB => low.map((channel, index) => Math.round(channel + (high[index] - channel) * fraction)) as RGB;

/** A custom hue always retains a light-to-dark numeric ramp, even for black/white. */
export function heatmapAppearance(display: Row) {
  const custom = normalizeHexColor(display.heatmapBaseColor);
  const palette = typeof display.color_scale === "string" && ["blue", "green", "purple", "gray"].includes(display.color_scale) ? display.color_scale : "blue";
  const baseColor = custom ?? hexColor(channels(heatmapColor(1, 0, 1, palette)));
  const base = channels(baseColor);
  const low = custom ? rgbColor(mix([255, 255, 255], base, 0.12)) : heatmapColor(0, 0, 1, palette);
  const high = custom ? rgbColor(mix([0, 0, 0], base, 0.75)) : heatmapColor(1, 0, 1, palette);
  return {
    baseColor, low, high, opacity: panelFillOpacity(display),
    color: (value: number | null, min: number, max: number) => value === null ? heatmapColor(null, min, max)
      : custom ? rgbColor(mix(channels(low), channels(high), heatmapFraction(value, min, max)))
      : heatmapColor(value, min, max, palette),
  };
}

/** For CSS legends: only the painted gradient is translucent, never its labels. */
export function colorWithOpacity(color: string, opacity: number): string {
  return `rgba(${channels(color).join(", ")}, ${opacity})`;
}

/** Contrast is based on the fill composited onto the panel surface, not its raw hue. */
export function heatmapTextColor(fill: string, opacity: number, surface: string): string {
  const rgb = mix(channels(surface), channels(fill), opacity);
  const linear = rgb.map(channel => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; });
  const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  return luminance > 0.179 ? "#000000" : "#ffffff";
}
