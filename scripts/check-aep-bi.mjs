import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function checkGolden(aep, vendored = resolve(dirname(fileURLToPath(import.meta.url)), '../web/tests/fixtures/aep_bi')) {
  const upstream = resolve(aep, 'tests/fixtures/bi_feed/golden');
  const files = async path => (await readdir(path)).filter(name => name.endsWith('.json')).sort();
  const [expected, actual] = await Promise.all([files(upstream), files(vendored)]);
  if (!expected.length) throw new Error('AEP golden fixtures are missing');
  if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('BI golden fixture filenames differ');
  for (const name of expected) { const [left, right] = await Promise.all([readFile(resolve(upstream, name)), readFile(resolve(vendored, name))]); if (!left.equals(right)) throw new Error(`BI golden fixture differs: ${name}`); }
  return expected.length;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const index = process.argv.indexOf('--aep'); if (index < 0 || !process.argv[index + 1]) throw new Error('Usage: npm run check:aep-bi -- --aep <AEP repo>'); console.log(`BI golden fixtures match (${await checkGolden(process.argv[index + 1])} files)`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
