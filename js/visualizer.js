/**
 * Memory Visualizer
 *
 * Renders analysis results as an interactive SVG memory map.
 * Each memory segment (stack, heap, .rodata, .data, .bss, .text)
 * is rendered as a card containing its entries.
 */

const MemoryVisualizer = (() => {

  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Segment display config
  const SEGMENTS = {
    stack:  { label: 'Stack',   color: '#3b82f6', bgColor: 'rgba(59, 130, 246, 0.08)',  borderColor: 'rgba(59, 130, 246, 0.3)',  glowClass: 'glow-stack',  order: 0 },
    heap:   { label: 'Heap',    color: '#10b981', bgColor: 'rgba(16, 185, 129, 0.08)',  borderColor: 'rgba(16, 185, 129, 0.3)',  glowClass: 'glow-heap',   order: 1 },
    rodata: { label: '.rodata', color: '#8b5cf6', bgColor: 'rgba(139, 92, 246, 0.08)',  borderColor: 'rgba(139, 92, 246, 0.3)',  glowClass: 'glow-rodata', order: 2 },
    data:   { label: '.data',   color: '#f59e0b', bgColor: 'rgba(245, 158, 11, 0.08)',  borderColor: 'rgba(245, 158, 11, 0.3)',  glowClass: 'glow-data',   order: 3 },
    bss:    { label: '.bss',    color: '#6366f1', bgColor: 'rgba(99, 102, 241, 0.08)',  borderColor: 'rgba(99, 102, 241, 0.3)',  glowClass: 'glow-bss',    order: 4 },
    text:   { label: '.text',   color: '#6b7280', bgColor: 'rgba(107, 114, 128, 0.08)', borderColor: 'rgba(107, 114, 128, 0.3)', glowClass: 'glow-text',   order: 5 },
  };

  // Layout constants
  const PADDING = 20;
  const SEGMENT_GAP = 20;
  const SEGMENT_HEADER = 36;
  const ENTRY_HEIGHT = 38;
  const ENTRY_GAP = 6;
  const ENTRY_PADDING = 10;
  const MIN_SEGMENT_WIDTH = 180;
  const COLUMNS = 3; // segments per row

  let svgEl = null;
  let entryElements = {};  // id -> SVG group element
  let connectionElements = []; // connection line elements
  let entryPositions = {}; // id -> { x, y, width, height, segment }
  let currentAnalysis = null;
  let onHoverEntry = null;
  let onClickEntry = null;

  /**
   * Initialize the visualizer
   */
  function init(svgElement, callbacks = {}) {
    svgEl = svgElement;
    onHoverEntry = callbacks.onHoverEntry || (() => {});
    onClickEntry = callbacks.onClickEntry || (() => {});
  }

  /**
   * Render analysis results
   */
  function render(analysis) {
    if (!svgEl) return;
    currentAnalysis = analysis;
    entryElements = {};
    connectionElements = [];
    entryPositions = {};

    // Clear SVG
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);

    // Add defs for filters and markers
    const defs = createSVGElement('defs');

    // Arrow marker for connections
    const marker = createSVGElement('marker', {
      id: 'arrowhead',
      markerWidth: '8',
      markerHeight: '6',
      refX: '8',
      refY: '3',
      orient: 'auto',
    });
    const arrowPath = createSVGElement('path', {
      d: 'M0,0 L8,3 L0,6 Z',
      fill: '#64748b',
    });
    marker.appendChild(arrowPath);
    defs.appendChild(marker);

    // Glow filters for each segment
    for (const [seg, cfg] of Object.entries(SEGMENTS)) {
      const filter = createSVGElement('filter', {
        id: `glow-${seg}`,
        x: '-20%', y: '-20%', width: '140%', height: '140%',
      });
      const blur = createSVGElement('feGaussianBlur', {
        stdDeviation: '4',
        result: 'coloredBlur',
      });
      const flood = createSVGElement('feFlood', {
        'flood-color': cfg.color,
        'flood-opacity': '0.4',
        result: 'glowColor',
      });
      const composite = createSVGElement('feComposite', {
        in: 'glowColor',
        in2: 'coloredBlur',
        operator: 'in',
        result: 'softGlow',
      });
      const merge = createSVGElement('feMerge');
      const mergeNode1 = createSVGElement('feMergeNode', { in: 'softGlow' });
      const mergeNode2 = createSVGElement('feMergeNode', { in: 'SourceGraphic' });
      merge.appendChild(mergeNode1);
      merge.appendChild(mergeNode2);
      filter.appendChild(blur);
      filter.appendChild(flood);
      filter.appendChild(composite);
      filter.appendChild(merge);
      defs.appendChild(filter);
    }

    svgEl.appendChild(defs);

    const { entries } = analysis;
    if (!entries || entries.length === 0) return;

    // Group entries by segment
    const segmentGroups = {};
    for (const entry of entries) {
      const seg = entry.segment;
      if (!segmentGroups[seg]) segmentGroups[seg] = [];
      segmentGroups[seg].push(entry);
    }

    // Sort segments by display order
    const activeSegments = Object.keys(segmentGroups)
      .filter(s => SEGMENTS[s])
      .sort((a, b) => SEGMENTS[a].order - SEGMENTS[b].order);

    // Calculate layout
    const containerWidth = svgEl.parentElement?.clientWidth || 700;
    const cols = Math.min(COLUMNS, activeSegments.length);
    const segWidth = Math.max(MIN_SEGMENT_WIDTH, (containerWidth - PADDING * 2 - SEGMENT_GAP * (cols - 1)) / cols);

    let maxHeight = 0;

    // Position each segment
    const segmentPositions = {};
    activeSegments.forEach((seg, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);

      // Calculate segment height based on entries
      const entryCount = segmentGroups[seg].length;
      const segHeight = SEGMENT_HEADER + ENTRY_PADDING + entryCount * (ENTRY_HEIGHT + ENTRY_GAP) + ENTRY_PADDING;

      // Calculate row offset (sum of heights of previous rows)
      let rowY = PADDING;
      for (let r = 0; r < row; r++) {
        let maxRowHeight = 0;
        for (let c = 0; c < cols; c++) {
          const si = r * cols + c;
          if (si < activeSegments.length && segmentPositions[activeSegments[si]]) {
            maxRowHeight = Math.max(maxRowHeight, segmentPositions[activeSegments[si]].height);
          }
        }
        rowY += maxRowHeight + SEGMENT_GAP;
      }

      const x = PADDING + col * (segWidth + SEGMENT_GAP);
      const y = rowY;

      segmentPositions[seg] = { x, y, width: segWidth, height: segHeight };
      maxHeight = Math.max(maxHeight, y + segHeight);
    });

    // Set SVG size
    const totalWidth = PADDING * 2 + cols * segWidth + (cols - 1) * SEGMENT_GAP;
    svgEl.setAttribute('width', totalWidth);
    svgEl.setAttribute('height', maxHeight + PADDING + 40); // extra for connections
    svgEl.setAttribute('viewBox', `0 0 ${totalWidth} ${maxHeight + PADDING + 40}`);

    // Render each segment
    for (const seg of activeSegments) {
      const cfg = SEGMENTS[seg];
      const pos = segmentPositions[seg];
      const segEntries = segmentGroups[seg];

      const segGroup = createSVGElement('g', { class: 'mem-segment-group' });
      segGroup.style.animationDelay = `${cfg.order * 0.1}s`;

      // Segment background
      const bgRect = createSVGElement('rect', {
        class: 'mem-segment-bg',
        x: pos.x,
        y: pos.y,
        width: pos.width,
        height: pos.height,
        fill: cfg.bgColor,
        stroke: cfg.borderColor,
        'stroke-width': '1',
      });
      segGroup.appendChild(bgRect);

      // Segment header
      const headerBg = createSVGElement('rect', {
        x: pos.x,
        y: pos.y,
        width: pos.width,
        height: SEGMENT_HEADER,
        fill: cfg.borderColor,
        rx: '8',
        ry: '8',
      });
      segGroup.appendChild(headerBg);

      // Fix bottom corners of header
      const headerFix = createSVGElement('rect', {
        x: pos.x,
        y: pos.y + SEGMENT_HEADER - 8,
        width: pos.width,
        height: 8,
        fill: cfg.borderColor,
      });
      segGroup.appendChild(headerFix);

      // Header label
      const headerText = createSVGElement('text', {
        x: pos.x + 14,
        y: pos.y + SEGMENT_HEADER / 2 + 1,
        fill: cfg.color,
        'font-size': '13',
        'font-weight': '700',
        'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
        'dominant-baseline': 'middle',
        'text-transform': 'uppercase',
        'letter-spacing': '0.05em',
      });
      headerText.textContent = cfg.label;
      segGroup.appendChild(headerText);

      // Entry count badge
      const countText = createSVGElement('text', {
        x: pos.x + pos.width - 14,
        y: pos.y + SEGMENT_HEADER / 2 + 1,
        fill: cfg.color,
        'font-size': '11',
        'font-weight': '600',
        'font-family': '-apple-system, BlinkMacSystemFont, sans-serif',
        'dominant-baseline': 'middle',
        'text-anchor': 'end',
        opacity: '0.7',
      });
      countText.textContent = `${segEntries.length} item${segEntries.length !== 1 ? 's' : ''}`;
      segGroup.appendChild(countText);

      // Render entries
      segEntries.forEach((entry, ei) => {
        const entryY = pos.y + SEGMENT_HEADER + ENTRY_PADDING + ei * (ENTRY_HEIGHT + ENTRY_GAP);
        const entryX = pos.x + ENTRY_PADDING;
        const entryW = pos.width - ENTRY_PADDING * 2;

        const entryGroup = createSVGElement('g', {
          class: 'mem-entry-group',
          'data-id': entry.id,
          'data-line': entry.line,
          'data-segment': seg,
        });
        entryGroup.style.animationDelay = `${cfg.order * 0.1 + ei * 0.05}s`;

        // Entry background
        const entryBg = createSVGElement('rect', {
          class: 'mem-entry-bg',
          x: entryX,
          y: entryY,
          width: entryW,
          height: ENTRY_HEIGHT,
          fill: 'rgba(15, 21, 32, 0.6)',
          stroke: cfg.borderColor,
          'stroke-width': '1',
          rx: '4',
          ry: '4',
        });
        entryGroup.appendChild(entryBg);

        // Left color bar
        const colorBar = createSVGElement('rect', {
          x: entryX,
          y: entryY,
          width: 3,
          height: ENTRY_HEIGHT,
          fill: cfg.color,
          rx: '4',
          ry: '0',
        });
        entryGroup.appendChild(colorBar);

        // Entry name
        const truncatedName = entry.name.length > 20 ? entry.name.slice(0, 18) + '..' : entry.name;
        const nameText = createSVGElement('text', {
          x: entryX + 12,
          y: entryY + 15,
          fill: '#e2e8f0',
          'font-size': '12',
          'font-weight': '600',
          'font-family': "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
          'dominant-baseline': 'middle',
        });
        nameText.textContent = truncatedName;
        entryGroup.appendChild(nameText);

        // Entry type / info
        const infoText = entry.size ? `${entry.type} (${entry.size}B)` : entry.type;
        const truncatedInfo = infoText.length > 24 ? infoText.slice(0, 22) + '..' : infoText;
        const typeText = createSVGElement('text', {
          x: entryX + 12,
          y: entryY + 30,
          fill: '#64748b',
          'font-size': '10',
          'font-family': "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
          'dominant-baseline': 'middle',
        });
        typeText.textContent = truncatedInfo;
        entryGroup.appendChild(typeText);

        // Line number badge
        if (entry.line) {
          const lineText = createSVGElement('text', {
            x: entryX + entryW - 8,
            y: entryY + ENTRY_HEIGHT / 2,
            fill: '#475569',
            'font-size': '10',
            'font-family': "'JetBrains Mono', monospace",
            'dominant-baseline': 'middle',
            'text-anchor': 'end',
          });
          lineText.textContent = `L${entry.line}`;
          entryGroup.appendChild(lineText);
        }

        // Hover events
        entryGroup.addEventListener('mouseenter', () => handleEntryHover(entry, true));
        entryGroup.addEventListener('mouseleave', () => handleEntryHover(entry, false));
        entryGroup.addEventListener('click', (e) => handleEntryClick(entry, e));

        segGroup.appendChild(entryGroup);
        entryElements[entry.id] = entryGroup;
        entryPositions[entry.id] = {
          x: entryX,
          y: entryY,
          width: entryW,
          height: ENTRY_HEIGHT,
          centerX: entryX + entryW / 2,
          centerY: entryY + ENTRY_HEIGHT / 2,
          rightX: entryX + entryW,
          leftX: entryX,
          segment: seg,
        };
      });

      svgEl.appendChild(segGroup);
    }

    // Render connections (arrows between entries)
    renderConnections(entries);
  }

  /**
   * Render connection lines between related entries
   */
  function renderConnections(entries) {
    const connGroup = createSVGElement('g', { class: 'connections-layer' });

    for (const entry of entries) {
      if (!entry.connections) continue;

      for (const conn of entry.connections) {
        const fromPos = entryPositions[conn.from];
        const toPos = entryPositions[conn.to];
        if (!fromPos || !toPos) continue;

        // Calculate connection path
        let path;
        const fromSeg = fromPos.segment;
        const toSeg = toPos.segment;

        // Determine if segments are in same column or different
        const fromX = fromPos.rightX;
        const fromY = fromPos.centerY;
        const toX = toPos.leftX;
        const toY = toPos.centerY;

        // Use a curved path
        const midX = (fromX + toX) / 2;
        const controlOffset = Math.abs(toX - fromX) * 0.4;

        path = `M ${fromX} ${fromY} C ${fromX + controlOffset} ${fromY}, ${toX - controlOffset} ${toY}, ${toX} ${toY}`;

        const pathEl = createSVGElement('path', {
          class: 'mem-connection',
          d: path,
          stroke: SEGMENTS[toSeg]?.color || '#64748b',
          'marker-end': 'url(#arrowhead)',
          'data-from': conn.from,
          'data-to': conn.to,
        });

        // Label
        if (conn.label) {
          const labelX = midX;
          const labelY = (fromY + toY) / 2 - 8;
          const label = createSVGElement('text', {
            x: labelX,
            y: labelY,
            fill: '#475569',
            'font-size': '9',
            'font-family': '-apple-system, sans-serif',
            'text-anchor': 'middle',
            'dominant-baseline': 'middle',
            class: 'connection-label',
            'data-from': conn.from,
            'data-to': conn.to,
          });
          label.textContent = conn.label;
          connGroup.appendChild(label);
        }

        connGroup.appendChild(pathEl);
        connectionElements.push(pathEl);
      }
    }

    // Insert connections before entries so they render behind
    if (svgEl.firstChild) {
      svgEl.insertBefore(connGroup, svgEl.children[1]); // after defs
    }
  }

  /**
   * Handle hover on an entry
   */
  function handleEntryHover(entry, isHovering) {
    // Highlight the entry
    const el = entryElements[entry.id];
    if (el) {
      const bg = el.querySelector('.mem-entry-bg');
      if (isHovering) {
        bg?.classList.add('highlighted');
        bg?.setAttribute('stroke-width', '2');
        el.style.filter = `url(#glow-${entry.segment})`;
      } else {
        bg?.classList.remove('highlighted');
        bg?.setAttribute('stroke-width', '1');
        el.style.filter = '';
      }
    }

    // Highlight connections
    for (const conn of connectionElements) {
      const from = conn.getAttribute('data-from');
      const to = conn.getAttribute('data-to');
      if (from === entry.id || to === entry.id) {
        conn.classList.toggle('highlighted', isHovering);
      }
    }

    // Highlight connected entries
    if (entry.connections) {
      for (const conn of entry.connections) {
        const targetId = conn.from === entry.id ? conn.to : conn.from;
        const targetEl = entryElements[targetId];
        if (targetEl) {
          const targetBg = targetEl.querySelector('.mem-entry-bg');
          if (isHovering) {
            targetBg?.classList.add('highlighted');
            targetBg?.setAttribute('stroke-width', '2');
          } else {
            targetBg?.classList.remove('highlighted');
            targetBg?.setAttribute('stroke-width', '1');
          }
        }
      }
    }

    // Also check if other entries reference this one
    if (currentAnalysis) {
      for (const other of currentAnalysis.entries) {
        if (other.connections) {
          for (const conn of other.connections) {
            if (conn.to === entry.id || conn.from === entry.id) {
              const otherId = conn.from === entry.id ? conn.to : conn.from;
              const otherEl = entryElements[otherId];
              if (otherEl) {
                const bg = otherEl.querySelector('.mem-entry-bg');
                if (isHovering) {
                  bg?.classList.add('highlighted');
                } else {
                  bg?.classList.remove('highlighted');
                }
              }
            }
          }
        }
      }
    }

    // Notify callback (for code highlighting)
    onHoverEntry(entry, isHovering);
  }

  /**
   * Handle click on an entry
   */
  function handleEntryClick(entry, event) {
    onClickEntry(entry, event);
  }

  /**
   * Highlight entries by line number (called from code editor hover)
   */
  function highlightByLine(lineNum, isHighlighting) {
    if (!currentAnalysis) return;

    for (const entry of currentAnalysis.entries) {
      if (entry.line === lineNum) {
        const el = entryElements[entry.id];
        if (el) {
          const bg = el.querySelector('.mem-entry-bg');
          if (isHighlighting) {
            bg?.classList.add('highlighted');
            bg?.setAttribute('stroke-width', '2');
            el.style.filter = `url(#glow-${entry.segment})`;
          } else {
            bg?.classList.remove('highlighted');
            bg?.setAttribute('stroke-width', '1');
            el.style.filter = '';
          }
        }

        // Highlight connections for this entry
        for (const conn of connectionElements) {
          const from = conn.getAttribute('data-from');
          const to = conn.getAttribute('data-to');
          if (from === entry.id || to === entry.id) {
            conn.classList.toggle('highlighted', isHighlighting);
          }
        }
      }
    }
  }

  /**
   * Highlight a specific entry by ID (called from timeline)
   */
  function highlightById(entryId, isHighlighting) {
    const el = entryElements[entryId];
    if (!el) return;

    const entry = currentAnalysis?.entries.find(e => e.id === entryId);
    if (!entry) return;

    const bg = el.querySelector('.mem-entry-bg');
    if (isHighlighting) {
      bg?.classList.add('highlighted');
      bg?.setAttribute('stroke-width', '2');
      el.style.filter = `url(#glow-${entry.segment})`;

      // Scroll entry into view
      const rect = el.getBoundingClientRect();
      const container = svgEl.parentElement;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    } else {
      bg?.classList.remove('highlighted');
      bg?.setAttribute('stroke-width', '1');
      el.style.filter = '';
    }
  }

  /**
   * Clear all highlights
   */
  function clearHighlights() {
    for (const [id, el] of Object.entries(entryElements)) {
      const bg = el.querySelector('.mem-entry-bg');
      bg?.classList.remove('highlighted');
      bg?.setAttribute('stroke-width', '1');
      el.style.filter = '';
    }
    for (const conn of connectionElements) {
      conn.classList.remove('highlighted');
    }
  }

  /**
   * Helper: create SVG element with attributes
   */
  function createSVGElement(tag, attrs = {}) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [key, val] of Object.entries(attrs)) {
      el.setAttribute(key, val);
    }
    return el;
  }

  // Public API
  return {
    init,
    render,
    highlightByLine,
    highlightById,
    clearHighlights,
    SEGMENTS,
  };

})();
