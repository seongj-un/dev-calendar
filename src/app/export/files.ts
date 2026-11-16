import { localIsoDate } from '../../model/date';

/** Saves text as a file through a temporary link. */
export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before the URL goes away.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** "datebook-2026-12-08.ics" */
export function exportFileName(now: Date, ext: 'ics' | 'json'): string {
  return `datebook-${localIsoDate(now)}.${ext}`;
}

/** The chosen file is bigger than the limit; it was not read. */
export class FileTooLargeError extends Error {}

/**
 * Lets the person pick one file and returns its text, or null when they cancel.
 * With `maxBytes`, a bigger file is refused from its size before any of it is read.
 */
export function pickTextFile(
  accept: string,
  maxBytes = Infinity,
): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.hidden = true;
    document.body.append(input);
    const done = () => input.remove();
    input.addEventListener('cancel', () => {
      done();
      resolve(null);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      done();
      if (!file) {
        resolve(null);
        return;
      }
      if (file.size > maxBytes) {
        reject(new FileTooLargeError());
        return;
      }
      file.text().then((text) => resolve({ name: file.name, text }), reject);
    });
    input.click();
  });
}
