import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PageGeometry } from '@docreview/shared';
import type { PageRect } from '../../lib/geometry';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const GAP = 16;
const OVERSCAN = 600;

export type ScrollTarget = { page: number; y: number; nonce: number } | null;

type Props = {
  url: string;
  geometry: PageGeometry[];
  scale: number;
  highlights: PageRect[];
  scrollTarget: ScrollTarget;
};

/**
 * The viewer knows nothing about fields. It takes rectangles and a scroll
 * target. One derived selector upstream joins it to the review list; when
 * scanned documents arrive, only the geometry source changes.
 */
export function PdfViewer({ url, geometry, scale, highlights, scrollTarget }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(800);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    const task = pdfjs.getDocument(url);
    task.promise
      .then((d) => { if (!cancelled) setDoc(d); })
      .catch((err) => {
        // Swallowing this leaves a blank white rectangle where the document
        // should be, with no way to tell a failed render from an empty page.
        if (cancelled) return;
        console.error('[viewer] failed to load PDF', err);
        setLoadError(err?.message ?? String(err));
      });
    return () => { cancelled = true; task.destroy(); };
  }, [url]);

  // Exact heights, known before anything renders: getViewport does not rasterise.
  // The usual hard part of virtual scrolling — estimation and re-anchoring —
  // simply does not arise.
  const layout = useMemo(() => {
    let top = 0;
    return geometry.map((g) => {
      const entry = { page: g.page, top, height: g.height * scale, width: g.width * scale };
      top += entry.height + GAP;
      return entry;
    });
  }, [geometry, scale]);

  const totalHeight = layout.length ? layout[layout.length - 1].top + layout[layout.length - 1].height : 0;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setViewportH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!scrollTarget || !scroller.current) return;
    const page = layout.find((l) => l.page === scrollTarget.page);
    if (!page) return;
    const y = page.top + scrollTarget.y * scale;
    const el = scroller.current;
    const top = el.scrollTop;
    // Only scroll if the evidence is actually off-screen. Yanking the viewport
    // for something already visible is disorienting.
    if (y < top + 40 || y > top + el.clientHeight - 80) {
      el.scrollTo({
        top: Math.max(0, y - el.clientHeight / 3),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
  }, [scrollTarget, layout, scale]);

  const visible = layout.filter(
    (l) => l.top + l.height > scrollTop - OVERSCAN && l.top < scrollTop + viewportH + OVERSCAN,
  );

  return (
    <div
      className="viewer"
      ref={scroller}
      onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
    >
      {loadError && (
        <p className="viewer-error" role="alert">
          Could not render this PDF: {loadError}
        </p>
      )}
      <div className="viewer-canvas" style={{ height: totalHeight }}>
        {visible.map((l) => (
          <PageLayer
            key={l.page}
            doc={doc}
            page={l.page}
            top={l.top}
            width={l.width}
            height={l.height}
            scale={scale}
            highlights={highlights.filter((h) => h.page === l.page)}
          />
        ))}
      </div>
    </div>
  );
}

const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

function PageLayer({
  doc, page, top, width, height, scale, highlights,
}: {
  doc: pdfjs.PDFDocumentProxy | null;
  page: number; top: number; width: number; height: number; scale: number;
  highlights: PageRect[];
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!doc) return;
    let task: pdfjs.RenderTask | null = null;
    let cancelled = false;

    doc.getPage(page).then((p) => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = p.getViewport({ scale: scale * dpr });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      task = p.render({ canvasContext: ctx, viewport });
      task.promise.catch(() => { /* cancelled */ });
    });

    // Render tasks must be cancelled or canvases leak and frames tear on fast scroll.
    return () => { cancelled = true; task?.cancel(); };
  }, [doc, page, scale]);

  return (
    <div className="page" style={{ top, width, height }}>
      <canvas ref={canvasRef} style={{ width, height }} aria-label={`Page ${page}`} />
      <div className="highlights" aria-hidden="true">
        {highlights.map((h, i) => (
          <mark
            key={i}
            className="highlight"
            style={{ left: h.rect.x, top: h.rect.y, width: h.rect.w, height: h.rect.h }}
          />
        ))}
      </div>
      <span className="page-number" aria-hidden="true">{page}</span>
    </div>
  );
}
