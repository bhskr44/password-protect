// Draws a seal from a SHA-256. It is a picture of the hash itself: every hex
// digit sets one tick around the ring, so equal content gives an equal seal and
// any change gives a visibly different one.
const SVG = 'http://www.w3.org/2000/svg';

function svgElement(name, attributes) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

function drawSeal(sha256, { label = true } = {}) {
  const svg = svgElement('svg', { viewBox: '0 0 200 200', class: 'seal', role: 'img' });
  svg.setAttribute('aria-label', `Seal for SHA-256 ${sha256}`);
  const nibble = (index) => parseInt(sha256[index], 16);
  const byte = (index) => parseInt(sha256.slice(index * 2, index * 2 + 2), 16);

  const body = svgElement('g', { transform: `rotate(${(byte(0) % 13) - 6} 100 100)` });
  svg.append(body);
  for (const [r, width] of [[96, 3], [91, 1], [58, 1.5]]) {
    body.append(svgElement('circle', { cx: 100, cy: 100, r, 'stroke-width': width, class: 'seal-line' }));
  }

  for (let i = 0; i < 64; i++) {
    const angle = (i / 64) * Math.PI * 2 - Math.PI / 2;
    const inner = 62;
    const outer = inner + 4 + nibble(i) * 1.6;
    body.append(svgElement('line', {
      x1: 100 + Math.cos(angle) * inner,
      y1: 100 + Math.sin(angle) * inner,
      x2: 100 + Math.cos(angle) * outer,
      y2: 100 + Math.sin(angle) * outer,
      'stroke-width': 2.6,
      class: 'seal-line',
    }));
  }

  const points = [];
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2 - Math.PI / 2;
    const radius = 26 + (byte(i) / 255) * 26;
    points.push(`${(100 + Math.cos(angle) * radius).toFixed(1)},${(100 + Math.sin(angle) * radius).toFixed(1)}`);
  }
  body.append(svgElement('polygon', {
    points: points.join(' '), 'stroke-width': 1.5, class: label ? 'seal-line seal-faint' : 'seal-fill',
  }));

  if (label) {
    for (const [y, text] of [[95, sha256.slice(0, 4)], [116, sha256.slice(-4)]]) {
      const line = svgElement('text', { x: 100, y, 'text-anchor': 'middle', class: 'seal-text' });
      line.textContent = text;
      body.append(line);
    }
  }
  return svg;
}

function drawEmptySeal() {
  const svg = svgElement('svg', { viewBox: '0 0 200 200', class: 'seal seal-empty', 'aria-hidden': 'true' });
  for (const [r, dash] of [[96, '3 7'], [58, '2 6']]) {
    svg.append(svgElement('circle', {
      cx: 100, cy: 100, r, 'stroke-width': 2, 'stroke-dasharray': dash, class: 'seal-line',
    }));
  }
  return svg;
}
