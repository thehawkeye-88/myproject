import { createRequire } from 'node:module';
import type { CharBox, PageGeometry } from '@docreview/shared';

const require = createRequire(import.meta.url);

// The legacy build is the one that runs under Node without a DOM.
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const standardFontDataUrl =
  require.resolve('pdfjs-dist/package.json').replace(/package\.json$/, '') +
  'standard_fonts/';

export type TextLayer = {
  text: string;
  pageCount: number;
  pageGeometry: PageGeometry[];
  charBoxes: CharBox[];
  textDensity: number;
};

/**
 * Canonical text extraction. Everything downstream — citations, highlights,
 * verification spans — indexes into `text`. It is produced exactly once, here,
 * and never re-derived on the client.
 */
export async function extractTextLayer(data: Uint8Array): Promise<TextLayer> {
  const doc = await pdfjs.getDocument({
    data,
    standardFontDataUrl,
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise;

  let text = '';
  const charBoxes: CharBox[] = [];
  const pageGeometry: PageGeometry[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const pageStart = text.length;

    for (const raw of content.items) {
      const item = raw as any;
      if (typeof item.str !== 'string') continue;

      const start = text.length;
      text += item.str;
      const end = text.length;

      if (item.str.length > 0) {
        const m = pdfjs.Util.transform(viewport.transform, item.transform);
        const h = item.height || Math.hypot(m[2], m[3]) || 10;
        charBoxes.push({
          charStart: start,
          charEnd: end,
          page: p,
          x: m[4],
          y: m[5] - h,
          w: item.width || 0,
          h,
        });
      }

      if (item.hasEOL) text += '\n';
    }

    if (p < doc.numPages) text += '\n\n';

    pageGeometry.push({
      page: p,
      width: viewport.width,
      height: viewport.height,
      charStart: pageStart,
      charEnd: text.length,
    });
  }

  return {
    text,
    pageCount: doc.numPages,
    pageGeometry,
    charBoxes,
    textDensity: doc.numPages ? text.length / doc.numPages : 0,
  };
}
