import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { isEmbedPath, parseEmbedRoute } from '../src/platform/embedRoute.ts';

const golden = async name => JSON.parse(await readFile(new URL(`./fixtures/atlas_embed_golden/${name}`, import.meta.url), 'utf8'));
const urls = await golden('example-urls.json');

for (const example of urls.urls) test(`embed URL golden: ${example.name}`, () => {
  const url = new URL(example.url, urls.base);
  assert.equal(isEmbedPath(url.pathname), true);
  assert.deepEqual(parseEmbedRoute(url.pathname, url.search), example.route);
});

test('embed mode needs the literal prefix the server also uses', () => {
  for (const path of ['/', '/embed', '/embedded/panel', '/%65mbed/panel']) assert.equal(isEmbedPath(path), false);
});

test('a parameter named like an object member stays plain data', () => {
  const route = parseEmbedRoute('/embed/panel', '?vault=v&slug=s&__proto__=x&constructor=y');
  assert.deepEqual(Object.keys(route.params).sort(), ['__proto__', 'constructor']);
  assert.equal(Object.getPrototypeOf(route.params), Object.prototype);
});
