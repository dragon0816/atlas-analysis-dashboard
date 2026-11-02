/** URL grammar of the read-only embed pages; docs/AEP_EMBED_CONTRACT.md is the contract. */
export type EmbedInvalidReason = 'unknown_route' | 'missing_name' | 'malformed_name' | 'missing_vault' | 'missing_slug' | 'duplicate_param';
export type EmbedRoute =
  | { kind: 'dashboard'; name: string }
  | { kind: 'panel'; vault: string; slug: string; params: Record<string, string> }
  | { kind: 'invalid'; reason: EmbedInvalidReason };

const PREFIX = '/embed/';
export function isEmbedPath(pathname: string) { return pathname.startsWith(PREFIX); }
export function parseEmbedRoute(pathname: string, search: string): EmbedRoute {
  const invalid = (reason: EmbedInvalidReason): EmbedRoute => ({ kind: 'invalid', reason });
  const [route, ...rest] = pathname.slice(PREFIX.length).split('/');
  if (route === 'dashboard') {
    if (rest.length > 1) return invalid('unknown_route');
    if (!rest[0]) return invalid('missing_name');
    try { return { kind: 'dashboard', name: decodeURIComponent(rest[0]) }; } catch { return invalid('malformed_name'); }
  }
  if (route !== 'panel' || rest.length) return invalid('unknown_route');
  const query = new URLSearchParams(search);
  // A repeated key has no single meaning, so it is refused rather than resolved silently.
  for (const key of query.keys()) if (query.getAll(key).length > 1) return invalid('duplicate_param');
  const vault = query.get('vault'), slug = query.get('slug');
  if (!vault) return invalid('missing_vault');
  if (!slug) return invalid('missing_slug');
  // fromEntries defines own data properties, so a key named __proto__ stays plain data.
  return { kind: 'panel', vault, slug, params: Object.fromEntries([...query].filter(([key]) => key !== 'vault' && key !== 'slug')) };
}
