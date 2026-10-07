const NS = 'http://www.w3.org/2000/svg';

/**
 * Tiny SVG sparkline (no canvas, so it scales crisply and needs no redraw
 * on resize). Returns an object with update(values, trend).
 */
export function createSparkline({ width = 140, height = 36, cls = 'spark', label = 'Price trend' } = {}) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', cls);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  const area = document.createElementNS(NS, 'path');
  const line = document.createElementNS(NS, 'path');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke-width', '1.6');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('vector-effect', 'non-scaling-stroke');
  area.setAttribute('stroke', 'none');
  area.setAttribute('opacity', '0.14');
  svg.append(area, line);

  return {
    el: svg,
    update(values) {
      const v = values.filter(Number.isFinite);
      if (v.length < 2) return;
      const min = Math.min(...v);
      const max = Math.max(...v);
      const span = max - min || 1;
      const pad = 3;
      const pts = v.map((y, i) => [(i / (v.length - 1)) * width, pad + (1 - (y - min) / span) * (height - pad * 2)]);
      const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
      line.setAttribute('d', d);
      area.setAttribute('d', `${d}L${width},${height}L0,${height}Z`);
      const color = v[v.length - 1] >= v[0] ? 'var(--up)' : 'var(--down)';
      line.setAttribute('stroke', color);
      area.setAttribute('fill', color);
    },
  };
}
