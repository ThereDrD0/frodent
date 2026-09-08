export const escapeHTML = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(text) {
  const tokens = [];
  const hold = html => { tokens.push(html); return `\u0000${tokens.length - 1}\u0000`; };
  let safe = escapeHTML(text.replace(/\u0000/g, ''));
  safe = safe.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  safe = safe.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => {
    if (!/^https?:\/\//i.test(url)) return label;
    return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`);
  });
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return safe.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)]);
}

// Intentionally small Markdown subset. Raw HTML and images are never interpreted.
export function renderMarkdown(source) {
  const lines = source.split('\n');
  const output = [];
  let code = null, list = null;
  const closeList = () => { if (list) { output.push(`</${list}>`); list = null; } };
  lines.forEach((line, index) => {
    if (/^```/.test(line)) {
      closeList();
      if (code !== null) { output.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`); code = null; }
      else code = [];
      return;
    }
    if (code !== null) { code.push(line); return; }
    const task = line.match(/^[-*] \[([ xX])\] (.*)/);
    const item = line.match(/^(?:[-*] |\d+\. )(.*)/);
    if (task || item) {
      const type = /^\d+\./.test(line) ? 'ol' : 'ul';
      if (list !== type) { closeList(); list = type; output.push(`<${type}>`); }
      if (task) output.push(`<li class="task"><label><input type="checkbox" data-line="${index}" ${task[1] !== ' ' ? 'checked' : ''}><span>${inline(task[2])}</span></label></li>`);
      else output.push(`<li>${inline(item[1])}</li>`);
      return;
    }
    closeList();
    if (!line.trim()) return;
    const heading = line.match(/^(#{1,3}) (.*)/);
    if (heading) output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`);
    else if (/^> ?/.test(line)) output.push(`<blockquote>${inline(line.replace(/^> ?/, ''))}</blockquote>`);
    else if (/^---+$/.test(line)) output.push('<hr>');
    else output.push(`<p>${inline(line)}</p>`);
  });
  closeList();
  if (code !== null) output.push(`<pre><code>${escapeHTML(code.join('\n'))}</code></pre>`);
  return output.join('');
}
export function wordCount(text) { return text.match(/[\p{L}\p{N}]+(?:[-’'][\p{L}\p{N}]+)*/gu)?.length || 0; }
