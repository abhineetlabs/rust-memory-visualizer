/**
 * Memory Visualizer — "Phosphor" Edition
 *
 * Renders analysis results as an interactive SVG memory map
 * with thick, glowing pointer arrows between segments.
 */

const MemoryVisualizer = (() => {

  const SVG_NS = 'http://www.w3.org/2000/svg';

  const SEGMENTS = {
    stack:  { label: 'Stack',   color: '#4ecdc4', bg: 'rgba(78,205,196,0.06)',  border: 'rgba(78,205,196,0.2)',  order: 0 },
    heap:   { label: 'Heap',    color: '#ff6b6b', bg: 'rgba(255,107,107,0.06)', border: 'rgba(255,107,107,0.2)', order: 1 },
    rodata: { label: '.rodata', color: '#c3a6ff', bg: 'rgba(195,166,255,0.06)', border: 'rgba(195,166,255,0.2)', order: 2 },
    data:   { label: '.data',   color: '#ffd93d', bg: 'rgba(255,217,61,0.06)',  border: 'rgba(255,217,61,0.2)',  order: 3 },
    bss:    { label: '.bss',    color: '#6bcb77', bg: 'rgba(107,203,119,0.06)', border: 'rgba(107,203,119,0.2)', order: 4 },
    text:   { label: '.text',   color: '#7a7a8e', bg: 'rgba(122,122,142,0.05)', border: 'rgba(122,122,142,0.15)', order: 5 },
  };

  const PAD = 50; // extra left margin for RBP/RSP labels
  const SEG_GAP = 24;
  const SEG_HEADER = 34;
  const ENTRY_H = 40;
  const ENTRY_GAP = 5;
  const ENTRY_PAD = 8;
  const MIN_SEG_W = 190;
  const COLS = 3;

  let svgEl = null;
  let entryElements = {};
  let connectionElements = [];
  let entryPositions = {};
  let currentAnalysis = null;
  let onHoverEntry = null;
  let onClickEntry = null;

  function init(svgElement, callbacks = {}) {
    svgEl = svgElement;
    onHoverEntry = callbacks.onHoverEntry || (() => {});
    onClickEntry = callbacks.onClickEntry || (() => {});
  }

  function render(analysis) {
    if (!svgEl) return;
    currentAnalysis = analysis;
    entryElements = {};
    connectionElements = [];
    entryPositions = {};

    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    const defs = el('defs');

    // Arrowhead markers per segment color
    for (const [seg, cfg] of Object.entries(SEGMENTS)) {
      const m = el('marker', {
        id: `arrow-${seg}`, markerWidth: '10', markerHeight: '8',
        refX: '9', refY: '4', orient: 'auto', markerUnits: 'userSpaceOnUse',
      });
      m.appendChild(el('path', { d: 'M0,0 L10,4 L0,8 L2,4 Z', fill: cfg.color, opacity: '0.8' }));
      defs.appendChild(m);
    }

    // Glow filters per segment
    for (const [seg, cfg] of Object.entries(SEGMENTS)) {
      const f = el('filter', { id: `glow-${seg}`, x: '-30%', y: '-30%', width: '160%', height: '160%' });
      f.appendChild(el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '3', result: 'blur' }));
      f.appendChild(el('feFlood', { 'flood-color': cfg.color, 'flood-opacity': '0.35', result: 'color' }));
      f.appendChild(el('feComposite', { in: 'color', in2: 'blur', operator: 'in', result: 'glow' }));
      const merge = el('feMerge');
      merge.appendChild(el('feMergeNode', { in: 'glow' }));
      merge.appendChild(el('feMergeNode', { in: 'SourceGraphic' }));
      f.appendChild(merge);
      defs.appendChild(f);
    }

    // Connection glow filter (broad, soft)
    const connGlow = el('filter', { id: 'conn-glow', x: '-40%', y: '-40%', width: '180%', height: '180%' });
    connGlow.appendChild(el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: '4' }));
    defs.appendChild(connGlow);

    svgEl.appendChild(defs);

    const { entries } = analysis;
    if (!entries || entries.length === 0) return;

    // Group by segment
    const groups = {};
    for (const e of entries) {
      if (!groups[e.segment]) groups[e.segment] = [];
      groups[e.segment].push(e);
    }

    const activeSegs = Object.keys(groups).filter(s => SEGMENTS[s]).sort((a, b) => SEGMENTS[a].order - SEGMENTS[b].order);
    const containerW = svgEl.parentElement?.clientWidth || 700;
    const cols = Math.min(COLS, activeSegs.length);
    const segW = Math.max(MIN_SEG_W, (containerW - PAD * 2 - SEG_GAP * (cols - 1)) / cols);

    let maxH = 0;
    const segPos = {};

    activeSegs.forEach((seg, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const count = groups[seg].length;
      const h = SEG_HEADER + ENTRY_PAD + count * (ENTRY_H + ENTRY_GAP) + ENTRY_PAD;

      let rowY = PAD;
      for (let r = 0; r < row; r++) {
        let mh = 0;
        for (let c = 0; c < cols; c++) {
          const si = r * cols + c;
          if (si < activeSegs.length && segPos[activeSegs[si]]) mh = Math.max(mh, segPos[activeSegs[si]].h);
        }
        rowY += mh + SEG_GAP;
      }

      segPos[seg] = { x: PAD + col * (segW + SEG_GAP), y: rowY, w: segW, h };
      maxH = Math.max(maxH, rowY + h);
    });

    const totalW = PAD * 2 + cols * segW + (cols - 1) * SEG_GAP;
    svgEl.setAttribute('width', totalW);
    svgEl.setAttribute('height', maxH + PAD + 60);
    svgEl.setAttribute('viewBox', `0 0 ${totalW} ${maxH + PAD + 60}`);

    // Draw segments
    for (const seg of activeSegs) {
      const cfg = SEGMENTS[seg];
      const p = segPos[seg];
      const segEntries = groups[seg];

      const g = el('g', { class: 'mem-segment-group' });
      g.style.animationDelay = `${cfg.order * 0.08}s`;

      // Segment bg
      g.appendChild(el('rect', {
        class: 'mem-segment-bg', x: p.x, y: p.y, width: p.w, height: p.h,
        fill: cfg.bg, stroke: cfg.border, 'stroke-width': '1', rx: '6', ry: '6',
      }));

      // Header bar
      g.appendChild(el('rect', {
        x: p.x, y: p.y, width: p.w, height: SEG_HEADER,
        fill: cfg.border, rx: '6', ry: '6',
      }));
      g.appendChild(el('rect', {
        x: p.x, y: p.y + SEG_HEADER - 6, width: p.w, height: 6, fill: cfg.border,
      }));

      // Header text
      const label = el('text', {
        x: p.x + 12, y: p.y + SEG_HEADER / 2 + 1,
        fill: cfg.color, 'font-size': '12', 'font-weight': '700',
        'font-family': "'Outfit', sans-serif", 'dominant-baseline': 'middle',
        'letter-spacing': '0.04em',
      });
      label.textContent = cfg.label.toUpperCase();
      g.appendChild(label);

      const countLabel = el('text', {
        x: p.x + p.w - 10, y: p.y + SEG_HEADER / 2 + 1,
        fill: cfg.color, 'font-size': '10', 'font-weight': '500',
        'font-family': "'JetBrains Mono', monospace", 'dominant-baseline': 'middle',
        'text-anchor': 'end', opacity: '0.5',
      });
      countLabel.textContent = segEntries.length;
      g.appendChild(countLabel);

      // Entries
      segEntries.forEach((entry, ei) => {
        const ey = p.y + SEG_HEADER + ENTRY_PAD + ei * (ENTRY_H + ENTRY_GAP);
        const ex = p.x + ENTRY_PAD;
        const ew = p.w - ENTRY_PAD * 2;

        const eg = el('g', {
          class: 'mem-entry-group', 'data-id': entry.id,
          'data-line': entry.line, 'data-segment': seg,
        });
        eg.style.animationDelay = `${cfg.order * 0.08 + ei * 0.04}s`;

        // Entry bg
        eg.appendChild(el('rect', {
          class: 'mem-entry-bg', x: ex, y: ey, width: ew, height: ENTRY_H,
          fill: 'rgba(12,12,16,0.7)', stroke: cfg.border, 'stroke-width': '1', rx: '4', ry: '4',
        }));

        // Left accent bar
        eg.appendChild(el('rect', {
          x: ex, y: ey + 4, width: '2.5', height: ENTRY_H - 8, fill: cfg.color, rx: '1',
        }));

        // Entry name
        const nameT = el('text', {
          x: ex + 12, y: ey + 16, fill: '#eae8e4', 'font-size': '12', 'font-weight': '600',
          'font-family': "'JetBrains Mono', monospace", 'dominant-baseline': 'middle',
        });
        const truncName = entry.name.length > 22 ? entry.name.slice(0, 20) + '..' : entry.name;
        nameT.textContent = truncName;
        eg.appendChild(nameT);

        // Entry type + size info
        const info = entry.size ? `${entry.type} (${entry.size}B)` : entry.type;
        const truncInfo = info.length > 28 ? info.slice(0, 26) + '..' : info;
        const typeT = el('text', {
          x: ex + 12, y: ey + 31, fill: '#5a5750', 'font-size': '10',
          'font-family': "'JetBrains Mono', monospace", 'dominant-baseline': 'middle',
        });
        typeT.textContent = truncInfo;
        eg.appendChild(typeT);

        // Stack pointer indicator — shows "ptr ->" on entries that own heap/rodata data
        const hasOutgoing = entry.connections && entry.connections.length > 0 && entry.connections.some(c => c.from === entry.id);
        if (hasOutgoing) {
          const targetConn = entry.connections.find(c => c.from === entry.id);
          const targetEntry = targetConn ? entries.find(e => e.id === targetConn.to) : null;
          const targetSeg = targetEntry ? targetEntry.segment : 'heap';
          const ptrColor = SEGMENTS[targetSeg]?.color || cfg.color;

          // "ptr ->" badge on the right side of the entry
          const badgeW = 42;
          const badgeX = ex + ew - badgeW - 4;
          const badgeY = ey + 5;
          eg.appendChild(el('rect', {
            x: badgeX, y: badgeY, width: badgeW, height: 14,
            fill: ptrColor, opacity: '0.12', rx: '2', ry: '2',
          }));
          const ptrLabel = el('text', {
            x: badgeX + badgeW / 2, y: badgeY + 7.5,
            fill: ptrColor, 'font-size': '8', 'font-weight': '700',
            'font-family': "'JetBrains Mono', monospace",
            'dominant-baseline': 'middle', 'text-anchor': 'middle',
            opacity: '0.8',
          });
          ptrLabel.textContent = 'ptr \u2192';
          eg.appendChild(ptrLabel);
        }

        // Line badge
        if (entry.line) {
          const lt = el('text', {
            x: ex + ew - 6, y: ey + 31, fill: '#3a3a4a', 'font-size': '9',
            'font-family': "'JetBrains Mono', monospace", 'dominant-baseline': 'middle', 'text-anchor': 'end',
          });
          lt.textContent = `L${entry.line}`;
          eg.appendChild(lt);
        }

        // Pointer dot (outgoing)
        if (hasOutgoing) {
          const targetConn2 = entry.connections.find(c => c.from === entry.id);
          const tgt2 = targetConn2 ? entries.find(e => e.id === targetConn2.to) : null;
          const dotColor = tgt2 ? (SEGMENTS[tgt2.segment]?.color || cfg.color) : cfg.color;
          eg.appendChild(el('circle', {
            class: 'ptr-dot', cx: ex + ew - 1, cy: ey + ENTRY_H / 2,
            r: '4', fill: dotColor, opacity: '0.7', 'data-id': entry.id,
          }));
        }

        // Pointer target dot (incoming)
        const isTarget = entries.some(e => e.connections && e.connections.some(c => c.to === entry.id));
        if (isTarget) {
          const dot = el('circle', {
            class: 'ptr-dot', cx: ex + 1, cy: ey + ENTRY_H / 2,
            r: '4', fill: cfg.color, opacity: '0.7',
            'data-id': entry.id,
          });
          eg.appendChild(dot);
        }

        eg.addEventListener('mouseenter', () => handleHover(entry, true));
        eg.addEventListener('mouseleave', () => handleHover(entry, false));
        eg.addEventListener('click', (e) => onClickEntry(entry, e));

        g.appendChild(eg);
        entryElements[entry.id] = eg;
        entryPositions[entry.id] = {
          x: ex, y: ey, w: ew, h: ENTRY_H,
          cx: ex + ew / 2, cy: ey + ENTRY_H / 2,
          rx: ex + ew, lx: ex, segment: seg,
        };
      });

      // Stack registers — show RBP and RSP for the stack segment
      if (seg === 'stack' && segEntries.length > 0) {
        const firstEntryY = p.y + SEG_HEADER + ENTRY_PAD;
        const lastEntryY = p.y + SEG_HEADER + ENTRY_PAD + (segEntries.length - 1) * (ENTRY_H + ENTRY_GAP);
        const regX = p.x - 4;
        const regColor = '#ff9f43'; // amber accent

        // RBP — base pointer (top of frame)
        const rbpY = firstEntryY + 2;
        // Small arrow pointing right
        g.appendChild(el('line', {
          x1: regX - 22, y1: rbpY, x2: regX, y2: rbpY,
          stroke: regColor, 'stroke-width': '1.5', 'stroke-linecap': 'round', opacity: '0.6',
        }));
        g.appendChild(el('polygon', {
          points: `${regX},${rbpY - 3} ${regX + 5},${rbpY} ${regX},${rbpY + 3}`,
          fill: regColor, opacity: '0.6',
        }));
        const rbpLabel = el('text', {
          x: regX - 25, y: rbpY + 1,
          fill: regColor, 'font-size': '9', 'font-weight': '700',
          'font-family': "'JetBrains Mono', monospace",
          'dominant-baseline': 'middle', 'text-anchor': 'end', opacity: '0.7',
        });
        rbpLabel.textContent = 'RBP';
        g.appendChild(rbpLabel);

        // RSP — stack pointer (bottom of frame, grows downward)
        const rspY = lastEntryY + ENTRY_H - 2;
        g.appendChild(el('line', {
          x1: regX - 22, y1: rspY, x2: regX, y2: rspY,
          stroke: regColor, 'stroke-width': '1.5', 'stroke-linecap': 'round', opacity: '0.6',
        }));
        g.appendChild(el('polygon', {
          points: `${regX},${rspY - 3} ${regX + 5},${rspY} ${regX},${rspY + 3}`,
          fill: regColor, opacity: '0.6',
        }));
        const rspLabel = el('text', {
          x: regX - 25, y: rspY + 1,
          fill: regColor, 'font-size': '9', 'font-weight': '700',
          'font-family': "'JetBrains Mono', monospace",
          'dominant-baseline': 'middle', 'text-anchor': 'end', opacity: '0.7',
        });
        rspLabel.textContent = 'RSP';
        g.appendChild(rspLabel);

        // Dotted vertical line connecting RBP to RSP (the frame boundary)
        if (segEntries.length > 1) {
          g.appendChild(el('line', {
            x1: regX - 8, y1: rbpY + 6, x2: regX - 8, y2: rspY - 6,
            stroke: regColor, 'stroke-width': '1', 'stroke-dasharray': '3 4',
            'stroke-linecap': 'round', opacity: '0.3',
          }));
        }
      }

      svgEl.appendChild(g);
    }

    // Draw connections ON TOP of segments (rendered last = on top)
    drawConnections(entries);
  }

  function drawConnections(entries) {
    const layer = el('g', { class: 'connections-layer' });

    for (const entry of entries) {
      if (!entry.connections) continue;
      for (const conn of entry.connections) {
        const from = entryPositions[conn.from];
        const to = entryPositions[conn.to];
        if (!from || !to) continue;

        const toSeg = to.segment;
        const color = SEGMENTS[toSeg]?.color || '#7a7a8e';

        // Path from right edge of source to left edge of target
        const fx = from.rx - 1;
        const fy = from.cy;
        const tx = to.lx + 1;
        const ty = to.cy;

        // Bezier control points — nice curve
        const dx = Math.abs(tx - fx);
        const cp = Math.max(dx * 0.45, 40);
        const d = `M${fx},${fy} C${fx + cp},${fy} ${tx - cp},${ty} ${tx},${ty}`;

        // Glow layer (blurred, behind)
        const glow = el('path', {
          d, stroke: color, 'stroke-width': '6', fill: 'none',
          opacity: '0.1', filter: 'url(#conn-glow)',
          'data-from': conn.from, 'data-to': conn.to,
        });
        layer.appendChild(glow);

        // Base solid line
        const base = el('path', {
          class: 'mem-connection-base', d, stroke: color,
          'marker-end': `url(#arrow-${toSeg})`,
          'data-from': conn.from, 'data-to': conn.to,
        });
        layer.appendChild(base);
        connectionElements.push(base);

        // Animated flow dots
        const flow = el('path', {
          class: 'mem-connection-flow animated', d, stroke: color,
          'data-from': conn.from, 'data-to': conn.to,
        });
        layer.appendChild(flow);
        connectionElements.push(flow);

        // Connection label — skip "owns"/"points to" (too noisy), only show custom labels
        if (conn.label && conn.label !== 'owns' && conn.label !== 'points to') {
          const mx = (fx + tx) / 2;
          const my = (fy + ty) / 2 - 10;
          const lbl = el('text', {
            x: mx, y: my, fill: color, opacity: '0.5',
            'font-size': '9', 'font-family': "'DM Sans', sans-serif",
            'font-weight': '500', 'text-anchor': 'middle', 'dominant-baseline': 'middle',
            'data-from': conn.from, 'data-to': conn.to,
          });
          lbl.textContent = conn.label;
          layer.appendChild(lbl);
          connectionElements.push(lbl);
        }
      }
    }

    svgEl.appendChild(layer);
  }

  function handleHover(entry, on) {
    const elem = entryElements[entry.id];
    if (elem) {
      const bg = elem.querySelector('.mem-entry-bg');
      if (on) {
        bg?.classList.add('highlighted');
        bg?.setAttribute('stroke-width', '1.5');
        elem.style.filter = `url(#glow-${entry.segment})`;
      } else {
        bg?.classList.remove('highlighted');
        bg?.setAttribute('stroke-width', '1');
        elem.style.filter = '';
      }
    }

    // Highlight connections + connected entries
    const relatedIds = new Set();
    for (const c of connectionElements) {
      const f = c.getAttribute('data-from');
      const t = c.getAttribute('data-to');
      if (f === entry.id || t === entry.id) {
        c.classList.toggle('highlighted', on);
        if (f === entry.id) relatedIds.add(t);
        if (t === entry.id) relatedIds.add(f);
      }
    }

    // Also check reverse connections
    if (currentAnalysis) {
      for (const other of currentAnalysis.entries) {
        if (!other.connections) continue;
        for (const conn of other.connections) {
          if (conn.to === entry.id) relatedIds.add(conn.from);
          if (conn.from === entry.id) relatedIds.add(conn.to);
        }
      }
    }

    for (const rid of relatedIds) {
      const re = entryElements[rid];
      if (!re) continue;
      const rbg = re.querySelector('.mem-entry-bg');
      if (on) {
        rbg?.classList.add('highlighted');
        rbg?.setAttribute('stroke-width', '1.5');
      } else {
        rbg?.classList.remove('highlighted');
        rbg?.setAttribute('stroke-width', '1');
      }
    }

    onHoverEntry(entry, on);
  }

  function highlightByLine(lineNum, on) {
    if (!currentAnalysis) return;
    for (const entry of currentAnalysis.entries) {
      if (entry.line !== lineNum) continue;
      const elem = entryElements[entry.id];
      if (!elem) continue;
      const bg = elem.querySelector('.mem-entry-bg');
      if (on) {
        bg?.classList.add('highlighted');
        elem.style.filter = `url(#glow-${entry.segment})`;
      } else {
        bg?.classList.remove('highlighted');
        elem.style.filter = '';
      }
      for (const c of connectionElements) {
        const f = c.getAttribute('data-from');
        const t = c.getAttribute('data-to');
        if (f === entry.id || t === entry.id) c.classList.toggle('highlighted', on);
      }
    }
  }

  function highlightById(id, on) {
    const elem = entryElements[id];
    if (!elem) return;
    const entry = currentAnalysis?.entries.find(e => e.id === id);
    if (!entry) return;
    const bg = elem.querySelector('.mem-entry-bg');
    if (on) {
      bg?.classList.add('highlighted');
      elem.style.filter = `url(#glow-${entry.segment})`;
    } else {
      bg?.classList.remove('highlighted');
      elem.style.filter = '';
    }
  }

  function clearHighlights() {
    for (const [, elem] of Object.entries(entryElements)) {
      const bg = elem.querySelector('.mem-entry-bg');
      bg?.classList.remove('highlighted');
      bg?.setAttribute('stroke-width', '1');
      elem.style.filter = '';
    }
    for (const c of connectionElements) c.classList.remove('highlighted');
  }

  function el(tag, attrs = {}) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }

  return { init, render, highlightByLine, highlightById, clearHighlights, SEGMENTS };
})();
