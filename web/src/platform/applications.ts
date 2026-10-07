import { readApplicationPackages } from "./applicationLoader";
// Build-time application packages; data remains separate from Core domain logic.
const assets = import.meta.glob("../../../applications/**/*.{yaml,yml,json,csv}", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
export const applicationPackages = readApplicationPackages(assets);
