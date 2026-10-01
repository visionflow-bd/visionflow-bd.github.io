const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

test('site image templates include alt text', () => {
  const source = readFileSync('index.html', 'utf8');
  const tags = [...source.matchAll(/<img\b[^>]*>/gi)].map(match => match[0]);
  const missing = tags.filter(tag => !/\balt\s*=/.test(tag));
  assert.deepEqual(missing, []);
  assert.match(source, /const reviews = VFReviews\.filterPublicReviews\(STATE\.data\.reviews \|\| \[\]\);/);
  assert.match(source, /Client-consented testimonials will appear here after consent is verified/);
});
