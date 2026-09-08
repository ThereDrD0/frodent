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
export function humanSize(bytes) { return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`; }
export async function imageSize(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 400 / bitmap.width, 360 / bitmap.height);
  const result = { w: Math.max(40, bitmap.width * scale), h: Math.max(40, bitmap.height * scale) };
  bitmap.close(); return result;
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'file';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
}
