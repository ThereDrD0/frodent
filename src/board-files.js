import { connectorEndpoints, connectorPath } from './board-model.js';

export const MAX_FILE = 20 * 1024 * 1024;
const imageTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const documents = /\.(pdf|docx?|xlsx?|pptx?|txt|md|csv|odt|ods|odp|rtf)$/i;

export function fileKind(file) {
  if (!file.size) throw new Error(`«${file.name}»: файл пуст.`);
  if (file.size > MAX_FILE) throw new Error(`«${file.name}»: максимум 20 МБ на файл.`);
  if (imageTypes.includes(file.type)) return 'image';
  if (documents.test(file.name)) return 'file';
  throw new Error(`«${file.name}»: поддерживаются PNG, JPEG, WebP, GIF и документы PDF, Office, OpenDocument, TXT, MD, CSV, RTF.`);
}

export function humanSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export async function imageSize(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 400 / bitmap.width, 360 / bitmap.height);
  const result = { w: Math.max(40, bitmap.width * scale), h: Math.max(40, bitmap.height * scale) };
  bitmap.close();
  return result;
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'file';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function escapeXml(unsafe) {
  return String(unsafe ?? '').replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

const COLOR_MAP = {
  mint: {
    bg: '#9df2e8',
    text: '#00201d',
    stroke: '#006a63',
    shapeBg: 'rgba(157, 242, 232, 0.35)'
  },
  blue: {
    bg: '#cee5ff',
    text: '#001d33',
    stroke: '#47617a',
    shapeBg: 'rgba(206, 229, 255, 0.35)'
  },
  neutral: {
    bg: '#e2e2e5',
    text: '#161d1c',
    stroke: '#4a6360',
    shapeBg: 'rgba(204, 232, 228, 0.35)'
  }
};

function wrapText(text, maxChars = 28) {
  const lines = [];
  for (const para of String(text || '').split('\n')) {
    if (!para) {
      lines.push('');
      continue;
    }
    const words = para.split(' ');
    let line = '';
    for (const w of words) {
      if ((line + ' ' + w).trim().length > maxChars) {
        if (line) lines.push(line);
        line = w;
      } else {
        line = line ? line + ' ' + w : w;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function pointsToSvgPath(points, originX = 0, originY = 0) {
  if (!points || !points.length) return '';
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${originX + p[0]} ${originY + p[1]}`).join(' ');
}

async function blobToDataUrl(blob) {
  if (!blob) return null;
  if (typeof FileReader !== 'undefined') {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } else if (blob.arrayBuffer) {
    try {
      const buf = Buffer.from(await blob.arrayBuffer());
      return `data:${blob.type || 'image/png'};base64,${buf.toString('base64')}`;
    } catch {
      return null;
    }
  }
  return null;
}

export async function renderBoardSvg(title, objects = [], readBlob = null) {
  const activeObjects = (objects || []).filter(o => !o.deleted);
  const objectMap = new Map(activeObjects.map(o => [o.id, o]));
  const getObject = id => objectMap.get(id);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  if (activeObjects.length === 0) {
    minX = 0; minY = 0; maxX = 800; maxY = 600;
  } else {
    for (const o of activeObjects) {
      if (o.type === 'connector') {
        const ep = connectorEndpoints(o, getObject);
        minX = Math.min(minX, ep.start.x, ep.end.x);
        maxX = Math.max(maxX, ep.start.x, ep.end.x);
        minY = Math.min(minY, ep.start.y, ep.end.y);
        maxY = Math.max(maxY, ep.start.y, ep.end.y);
      } else {
        minX = Math.min(minX, o.x);
        maxX = Math.max(maxX, o.x + (o.w || 0));
        minY = Math.min(minY, o.y);
        maxY = Math.max(maxY, o.y + (o.h || 0));
      }
    }
  }

  const pad = 48;
  const vbX = Math.floor(minX - pad);
  const vbY = Math.floor(minY - pad);
  const width = Math.max(300, Math.ceil(maxX - minX + pad * 2));
  const height = Math.max(200, Math.ceil(maxY - minY + pad * 2));

  const defs = `
    <defs>
      <marker id="arrowhead-mint" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#006a63"/>
      </marker>
      <marker id="arrowhead-blue" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#47617a"/>
      </marker>
      <marker id="arrowhead-neutral" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="#4a6360"/>
      </marker>
      <filter id="sticky-shadow" x="-8%" y="-8%" width="120%" height="125%">
        <feDropShadow dx="0" dy="4" stdDeviation="5" flood-color="#001d33" flood-opacity="0.08"/>
      </filter>
    </defs>`;

  const bgRect = `<rect x="${vbX}" y="${vbY}" width="${width}" height="${height}" fill="#f4fbf9"/>`;

  const connectors = activeObjects.filter(o => o.type === 'connector');
  const items = activeObjects.filter(o => o.type !== 'connector');

  const connectorElements = [];
  for (const c of connectors) {
    const ep = connectorEndpoints(c, getObject);
    const p = connectorPath(ep.start, ep.end, c.fromSide, c.toSide, c.style || 'curved');
    const colorStyle = COLOR_MAP[c.color] || COLOR_MAP.mint;

    let svgItem = `<path d="${p.d}" fill="none" stroke="${colorStyle.stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" marker-end="url(#arrowhead-${c.color || 'mint'})"/>`;

    if (c.text) {
      const labelText = escapeXml(c.text);
      const labelW = Math.max(48, Math.min(260, labelText.length * 8 + 18));
      const mid = p.midpoint || { x: (ep.start.x + ep.end.x) / 2, y: (ep.start.y + ep.end.y) / 2 };
      svgItem += `
        <g transform="translate(${mid.x}, ${mid.y})">
          <rect x="${-labelW / 2}" y="-12" width="${labelW}" height="24" rx="5" fill="#e3eae7" stroke="#bec9c6" stroke-width="1"/>
          <text x="0" y="0" text-anchor="middle" dominant-baseline="central" font-size="12" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-weight="500" fill="#161d1c">${labelText}</text>
        </g>`;
    }
    connectorElements.push(svgItem);
  }

  const objectElements = [];
  for (const o of items) {
    const c = COLOR_MAP[o.color] || COLOR_MAP.mint;
    if (o.type === 'sticky') {
      const lines = wrapText(o.text, Math.max(14, Math.floor(o.w / 10)));
      const tspans = lines.map((l, i) => `<tspan x="22" dy="${i === 0 ? 0 : 22}">${escapeXml(l)}</tspan>`).join('');
      objectElements.push(`
        <g transform="translate(${o.x}, ${o.y})">
          <rect width="${o.w}" height="${o.h}" rx="6" fill="${c.bg}" filter="url(#sticky-shadow)"/>
          <path d="M ${o.w - 20} ${o.h} L ${o.w} ${o.h - 20} L ${o.w} ${o.h} Z" fill="rgba(0,0,0,0.06)"/>
          <text x="22" y="36" fill="${c.text}" font-size="16" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-weight="400">${tspans}</text>
        </g>`);
    } else if (o.type === 'shape') {
      const shapeKind = o.shapeKind || 'rect';
      let shapeTag = '';
      if (shapeKind === 'rect') {
        shapeTag = `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}" rx="12" fill="${c.shapeBg}" stroke="${c.stroke}" stroke-width="2"/>`;
      } else if (shapeKind === 'ellipse') {
        shapeTag = `<ellipse cx="${o.x + o.w / 2}" cy="${o.y + o.h / 2}" rx="${o.w / 2}" ry="${o.h / 2}" fill="${c.shapeBg}" stroke="${c.stroke}" stroke-width="2"/>`;
      } else if (shapeKind === 'diamond') {
        const pts = `${o.x + o.w / 2},${o.y} ${o.x + o.w},${o.y + o.h / 2} ${o.x + o.w / 2},${o.y + o.h} ${o.x},${o.y + o.h / 2}`;
        shapeTag = `<polygon points="${pts}" fill="${c.shapeBg}" stroke="${c.stroke}" stroke-width="2"/>`;
      }

      let textTag = '';
      if (o.text) {
        const lines = wrapText(o.text, Math.max(12, Math.floor(o.w / 11)));
        const lineHeight = 18;
        const totalHeight = lines.length * lineHeight;
        const startY = (o.y + o.h / 2) - (totalHeight / 2) + 12;
        const tspans = lines.map((l, i) => `<tspan x="${o.x + o.w / 2}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(l)}</tspan>`).join('');
        textTag = `<text x="${o.x + o.w / 2}" y="${startY}" text-anchor="middle" fill="#161d1c" font-size="14" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-weight="500">${tspans}</text>`;
      }
      objectElements.push(`<g>${shapeTag}${textTag}</g>`);
    } else if (o.type === 'text') {
      const isHeadline = !!o.headline;
      const isSmall = !!o.small;
      const fontSize = isHeadline ? 38 : isSmall ? 13 : 18;
      const fontWeight = isHeadline ? '600' : '400';
      const lineHeight = fontSize * 1.35;
      const lines = wrapText(o.text, Math.max(12, Math.floor(o.w / (fontSize * 0.55))));
      const textColor = o.color === 'mint' ? '#006a63' : o.color === 'blue' ? '#47617a' : '#161d1c';
      const tspans = lines.map((l, i) => `<tspan x="${o.x + 4}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(l)}</tspan>`).join('');
      objectElements.push(`
        <text x="${o.x + 4}" y="${o.y + fontSize}" fill="${textColor}" font-size="${fontSize}" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif" font-weight="${fontWeight}">${tspans}</text>`);
    } else if (o.type === 'stroke') {
      const pathD = pointsToSvgPath(o.points, o.x, o.y);
      objectElements.push(`
        <path d="${pathD}" fill="none" stroke="${c.stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else if (o.type === 'image') {
      let imageHref = null;
      if (typeof readBlob === 'function' && o.blobId) {
        try {
          const blob = await readBlob(o.blobId);
          imageHref = await blobToDataUrl(blob);
        } catch {}
      }
      if (!imageHref && o.asset === 'landscape') {
        imageHref = 'assets/landscape.svg';
      }

      if (imageHref) {
        objectElements.push(`
          <g transform="translate(${o.x}, ${o.y})">
            <rect width="${o.w}" height="${o.h}" rx="12" fill="#ffffff" stroke="#bec9c6" stroke-width="1"/>
            <image href="${imageHref}" x="4" y="4" width="${o.w - 8}" height="${o.h - 8}" preserveAspectRatio="xMidYMid meet"/>
          </g>`);
      } else {
        objectElements.push(`
          <g transform="translate(${o.x}, ${o.y})">
            <rect width="${o.w}" height="${o.h}" rx="12" fill="#e9efed" stroke="#bec9c6" stroke-width="1"/>
            <text x="${o.w / 2}" y="${o.h / 2}" text-anchor="middle" dominant-baseline="central" font-size="13" fill="#3f4947" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif">🖼 ${escapeXml(o.text || 'Изображение')}</text>
          </g>`);
      }
    } else if (o.type === 'file') {
      const fileName = escapeXml(o.text || 'Документ');
      objectElements.push(`
        <g transform="translate(${o.x}, ${o.y})">
          <rect width="${o.w}" height="${o.h}" rx="14" fill="#ffffff" stroke="#bec9c6" stroke-width="1"/>
          <rect x="14" y="${Math.max(10, o.h / 2 - 18)}" width="32" height="36" rx="6" fill="#cce8e4"/>
          <text x="30" y="${o.h / 2 + 5}" text-anchor="middle" font-size="16">📄</text>
          <text x="56" y="${o.h / 2 - 2}" font-size="13" font-weight="600" fill="#161d1c" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif">${fileName}</text>
          <text x="56" y="${o.h / 2 + 14}" font-size="11" fill="#3f4947" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif">Вложение</text>
        </g>`);
    }
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vbX} ${vbY} ${width} ${height}" width="${width}" height="${height}">
  <title>${escapeXml(title || 'Доска')}</title>
  ${defs}
  ${bgRect}
  <g id="connectors">${connectorElements.join('\n')}</g>
  <g id="objects">${objectElements.join('\n')}</g>
</svg>`;

  return { svg, width, height, minX: vbX, minY: vbY };
}

export async function exportBoardSvg(title, objects = [], readBlob = null) {
  const { svg } = await renderBoardSvg(title, objects, readBlob);
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  download(blob, `${title || 'доска'}.svg`);
  return blob;
}

export async function renderSvgToCanvas(svgString, width, height, preferredScale = 2) {
  if (typeof document === 'undefined') {
    throw new Error('renderSvgToCanvas доступен только в окружении браузера.');
  }
  const MAX_CANVAS_DIM = 8192;
  const scale = Math.min(preferredScale, MAX_CANVAS_DIM / Math.max(width, height, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);

  const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    await new Promise((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Не удалось отрендерить SVG на canvas.'));
      img.src = url;
    });

    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportBoardPng(title, objects = [], readBlob = null) {
  const { svg, width, height } = await renderBoardSvg(title, objects, readBlob);
  const canvas = await renderSvgToCanvas(svg, width, height, 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (!blob) return reject(new Error('Не удалось создать растровое изображение.'));
      download(blob, `${title || 'доска'}.png`);
      resolve(blob);
    }, 'image/png');
  });
}

export async function copyBoardPng(title, objects = [], readBlob = null) {
  const { svg, width, height } = await renderBoardSvg(title, objects, readBlob);
  const canvas = await renderSvgToCanvas(svg, width, height, 2);
  return new Promise((resolve, reject) => {
    canvas.toBlob(async blob => {
      if (!blob) return reject(new Error('Не удалось сформировать изображение для буфера.'));
      try {
        if (!navigator.clipboard || !navigator.clipboard.write) {
          throw new Error('Буфер обмена недоступен в этом браузере.');
        }
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        resolve(blob);
      } catch (err) {
        reject(err);
      }
    }, 'image/png');
  });
}
