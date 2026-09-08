import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, wordCount } from '../src/markdown.js';

test('Markdown renders headings, emphasis, lists and source-indexed tasks', () => {
  const html = renderMarkdown('## План\n\n**важно** и *курсив*\n- [ ] Написать\n- [x] Прочитать\n1. Первый\n2. Второй');
  assert.match(html, /<h2>План<\/h2>/);
  assert.match(html, /<strong>важно<\/strong>/);
  assert.match(html, /<em>курсив<\/em>/);
  assert.match(html, /data-line="3"/);
  assert.match(html, /data-line="4" checked/);
  assert.match(html, /<ol><li>Первый<\/li><li>Второй<\/li><\/ol>/);
});
test('HTML is escaped, executable links rejected and HTTPS links isolated', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n[bad](data:text/html,x)\n[good](https://example.com)');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="data:'));
  assert.match(html, /rel="noopener noreferrer"/);
});
test('Code stays literal, including unclosed fences', () => {
  assert.equal(renderMarkdown('`**literal**`'), '<p><code>**literal**</code></p>');
  assert.equal(renderMarkdown('```js\n<script>'), '<pre><code>&lt;script&gt;</code></pre>');
});
test('Quotes and attribute characters cannot escape links', () => {
  const html = renderMarkdown('[link](https://example.com/"onclick="x)');
  assert.ok(!html.includes('"onclick="'));
  assert.match(html, /&quot;/);
});
test('Counts Russian and English words without Markdown punctuation', () => {
  assert.equal(wordCount('## Привет, мир! **hello** — 2026'), 4);
  assert.equal(wordCount(''), 0);
});
