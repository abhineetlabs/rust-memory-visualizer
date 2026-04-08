/**
 * Assembly Viewer — Godbolt Compiler Explorer integration
 *
 * Fetches real x86-64 assembly from Godbolt's API and renders it
 * with source-line mapping, syntax highlighting, and cross-panel hover.
 */

const AssemblyViewer = (function () {
  'use strict';

  const GODBOLT_API = 'https://godbolt.org/api';
  const COMPILER_ID = 'nightly';

  // Alternating background bands for source-line grouping
  const BAND_COLORS = [
    'rgba(78,205,196,0.07)',
    'rgba(255,107,107,0.07)',
    'rgba(195,166,255,0.07)',
    'rgba(255,217,61,0.05)',
    'rgba(107,203,119,0.07)',
    'rgba(255,159,243,0.07)',
    'rgba(72,219,251,0.07)',
    'rgba(254,202,87,0.07)',
  ];

  // ── State ──────────────────────────────────
  let container = null;
  let onHoverLine = null;
  let currentAsm = [];
  let lineMap = new Map();     // srcLine → [asmIdx, …]
  let reverseMap = new Map();  // asmIdx  → srcLine
  let lastResult = null;

  // ── Public API ─────────────────────────────

  function init(containerEl, callbacks) {
    container = containerEl;
    onHoverLine = callbacks?.onHoverLine || null;
    showPlaceholder();
  }

  /**
   * Call the Godbolt Compiler Explorer API.
   * Returns the raw JSON response.
   */
  async function compile(source, optLevel) {
    optLevel = optLevel || '0';

    // Always compile as lib — binary mode doesn't emit asm for user code.
    // Make all fn declarations pub/#[no_mangle] so the compiler emits them.
    const asmSource = prepareSource(source);
    const userArguments = `-C opt-level=${optLevel} --edition 2021 --crate-type lib`;

    const resp = await fetch(`${GODBOLT_API}/compiler/${COMPILER_ID}/compile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({
        source: asmSource,
        options: {
          userArguments,
          filters: {
            intel: true,
            demangle: true,
            directives: true,
            commentOnly: true,
            labels: true,
            trim: true,
            libraryCode: false,
          },
        },
      }),
    });

    if (!resp.ok) throw new Error(`Compiler service returned ${resp.status}`);
    const result = await resp.json();

    // Filter asm to only user code (source.file is null for user code,
    // non-null for std library). Keep labels that precede user code.
    if (result.asm) {
      const totalLines = source.split('\n').length;
      result.asm = filterUserAsm(result.asm, totalLines);
    }

    lastResult = result;
    return result;
  }

  /**
   * Prepare source for Godbolt: make functions visible so the compiler
   * emits assembly for them. Only touches top-level fn declarations
   * (no leading whitespace) to avoid breaking impl/trait methods.
   */
  function prepareSource(source) {
    return source.replace(
      /^(pub\s+)?(async\s+)?(unsafe\s+)?fn\s+/gm,
      (match, pub_, async_, unsafe_) => {
        return '#[no_mangle] pub ' + (async_ || '') + (unsafe_ || '') + 'fn ';
      }
    );
  }

  /**
   * Keep only assembly lines from user source code (not std library).
   * Godbolt marks user code with source.file === null and line within range.
   */
  function filterUserAsm(asm, maxLine) {
    // First pass: mark which indices are user code
    const isUser = new Uint8Array(asm.length);
    for (let i = 0; i < asm.length; i++) {
      const src = asm[i].source;
      if (src && src.file === null && src.line >= 1 && src.line <= maxLine) {
        isUser[i] = 1;
      }
    }

    // Second pass: include function labels and jump-target labels near user code
    const result = [];
    let prevWasUser = false;

    for (let i = 0; i < asm.length; i++) {
      const text = (asm[i].text || '').trim();
      const isLabel = /^\S.*:\s*$/.test(text);
      const isEmpty = !text;

      if (isUser[i]) {
        // If the previous line was a label we skipped, include it
        if (!prevWasUser && i > 0 && /^\S.*:\s*$/.test((asm[i - 1].text || '').trim())) {
          result.push(asm[i - 1]);
        }
        result.push(asm[i]);
        prevWasUser = true;
      } else if (prevWasUser && (isLabel || isEmpty)) {
        // Keep internal labels and blank separators within user blocks
        result.push(asm[i]);
      } else {
        prevWasUser = false;
      }
    }

    return result;
  }

  /**
   * Render a Godbolt result into the container.
   * Returns { success: bool, errors: string[] | null }
   */
  function render(result) {
    if (!container) return { success: false, errors: ['No container'] };

    currentAsm = result.asm || [];
    const stderr = result.stderr || [];
    const errors = stderr.filter(s => stripAnsi(s.text || '').includes('error'));

    lineMap.clear();
    reverseMap.clear();

    // Build source ↔ asm mappings
    currentAsm.forEach((line, idx) => {
      const src = line.source?.line;
      if (src != null) {
        reverseMap.set(idx, src);
        if (!lineMap.has(src)) lineMap.set(src, []);
        lineMap.get(src).push(idx);
      }
    });

    container.innerHTML = '';

    // Compilation failed — show errors only
    // (Godbolt may return 1 empty asm line even on errors)
    const meaningfulAsm = currentAsm.filter(l => l.text?.trim());
    if (errors.length > 0 && meaningfulAsm.length === 0) {
      renderErrors(stderr);
      return { success: false, errors: stderr.map(e => stripAnsi(e.text || '')) };
    }

    // Warnings banner
    const warnings = stderr.filter(s => stripAnsi(s.text || '').includes('warning'));
    if (warnings.length > 0) {
      const banner = document.createElement('div');
      banner.className = 'asm-warnings';
      banner.textContent = `${warnings.length} warning${warnings.length !== 1 ? 's' : ''}`;
      banner.title = warnings.map(w => w.text).join('\n');
      container.appendChild(banner);
    }

    // Assembly lines
    const wrapper = document.createElement('div');
    wrapper.className = 'asm-lines';

    currentAsm.forEach((line, idx) => {
      const el = document.createElement('div');
      el.className = 'asm-line';
      el.dataset.idx = idx;

      const src = reverseMap.get(idx);
      if (src != null) {
        el.dataset.srcLine = src;
        el.classList.add('asm-has-source');
        el.style.background = BAND_COLORS[(src - 1) % BAND_COLORS.length];
      }

      const numSpan = document.createElement('span');
      numSpan.className = 'asm-linenum';
      numSpan.textContent = idx + 1;

      const srcSpan = document.createElement('span');
      srcSpan.className = 'asm-src';
      srcSpan.textContent = src != null ? `L${src}` : '';

      const textSpan = document.createElement('span');
      textSpan.className = 'asm-text';
      textSpan.innerHTML = highlightAsm(line.text || '');

      el.append(numSpan, srcSpan, textSpan);

      el.addEventListener('mouseenter', () => {
        if (src != null) {
          internalHighlight(src, true);
          if (onHoverLine) onHoverLine(src, true);
        }
      });
      el.addEventListener('mouseleave', () => {
        if (src != null) {
          internalHighlight(src, false);
          if (onHoverLine) onHoverLine(src, false);
        }
      });

      wrapper.appendChild(el);
    });

    container.appendChild(wrapper);

    // Attribution
    const attr = document.createElement('div');
    attr.className = 'asm-attribution';
    attr.innerHTML = 'powered by <a href="https://godbolt.org" target="_blank" rel="noopener">Compiler Explorer</a>';
    container.appendChild(attr);

    return { success: true, errors: null };
  }

  // ── Internal rendering helpers ─────────────

  function renderErrors(stderr) {
    const el = document.createElement('div');
    el.className = 'asm-errors';

    const title = document.createElement('div');
    title.className = 'asm-errors-title';
    title.textContent = 'Compilation Failed';
    el.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'asm-errors-desc';
    desc.textContent = 'The Rust compiler found errors in this code:';
    el.appendChild(desc);

    for (const line of stderr) {
      const lineEl = document.createElement('div');
      lineEl.className = 'asm-error-line';
      const clean = stripAnsi(line.text || '');
      if (clean.includes('error')) lineEl.classList.add('asm-is-error');
      else if (clean.includes('warning')) lineEl.classList.add('asm-is-warn');
      else lineEl.classList.add('asm-is-note');
      lineEl.textContent = clean;
      el.appendChild(lineEl);
    }

    container.appendChild(el);
  }

  // ── Syntax highlighting ────────────────────

  function highlightAsm(text) {
    if (!text || !text.trim()) return '';

    const raw = text;
    let html = escapeHTML(text);

    // Labels (lines ending with ":" that aren't comments)
    if (/^\S.*:\s*$/.test(raw.trim())) {
      return '<span class="asm-label">' + html + '</span>';
    }

    // Comments (# or ; style)
    html = html.replace(/(#.*)$/,  '<span class="asm-comment">$1</span>');
    html = html.replace(/(;.*)$/,  '<span class="asm-comment">$1</span>');

    // Size directives
    html = html.replace(/\b(QWORD|DWORD|WORD|BYTE)\b/g, '<span class="asm-directive">$1</span>');
    html = html.replace(/\bPTR\b/g, '<span class="asm-directive">PTR</span>');

    // Registers (must run before numbers to avoid partial matches)
    html = html.replace(
      /\b(r[abcd]x|r[sd]i|r[sb]p|r[89]|r1[0-5][dwb]?|e[abcd]x|e[sd]i|e[sb]p|[abcd][lh]|[sd]il|[sb]pl|xmm\d+|ymm\d+|zmm\d+)\b/gi,
      '<span class="asm-register">$1</span>'
    );

    // Numbers / immediates
    html = html.replace(/\b(0x[\da-fA-F]+|-?\d+)\b/g, '<span class="asm-number">$1</span>');

    // Mnemonic (first instruction word on the line)
    html = html.replace(
      /^(\s*)((?:rep[a-z]*\s+)?[a-z][\w.]*)/i,
      '$1<span class="asm-mnemonic">$2</span>'
    );

    return html;
  }

  function escapeHTML(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Strip ANSI escape codes (rustc stderr includes color codes) */
  function stripAnsi(str) {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }

  // ── Highlighting ───────────────────────────

  function internalHighlight(srcLine, on) {
    if (!container) return;
    // Clear all highlights first
    container.querySelectorAll('.asm-line.highlighted').forEach(el => {
      el.classList.remove('highlighted');
    });
    // Apply new highlight
    if (on && srcLine != null) {
      const sel = '.asm-line[data-src-line="' + srcLine + '"]';
      container.querySelectorAll(sel).forEach(el => {
        el.classList.add('highlighted');
      });
    }
  }

  function highlightBySourceLine(srcLine, on) {
    internalHighlight(srcLine, on);
    if (on && srcLine != null) {
      const first = container?.querySelector('.asm-line[data-src-line="' + srcLine + '"]');
      if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ── Status displays ────────────────────────

  function clear() {
    if (container) container.innerHTML = '';
    currentAsm = [];
    lineMap.clear();
    reverseMap.clear();
    lastResult = null;
  }

  function showLoading() {
    if (!container) return;
    container.innerHTML =
      '<div class="asm-loading">' +
        '<div class="asm-spinner"></div>' +
        '<span>compiling via godbolt...</span>' +
      '</div>';
  }

  function showPlaceholder() {
    if (!container) return;
    container.innerHTML =
      '<div class="asm-placeholder">' +
        '<div class="asm-placeholder-icon">asm</div>' +
        '<p>analyze code to see assembly</p>' +
      '</div>';
  }

  function showOffline() {
    if (!container) return;
    container.innerHTML =
      '<div class="asm-placeholder">' +
        '<p>assembly unavailable &mdash; could not reach compiler service</p>' +
        '<p class="asm-placeholder-sub">the memory layout still works offline</p>' +
      '</div>';
  }

  function getLastResult() {
    return lastResult;
  }

  // ── Exports ────────────────────────────────

  return {
    init,
    compile,
    render,
    highlightBySourceLine,
    clear,
    showLoading,
    showPlaceholder,
    showOffline,
    getLastResult,
  };
})();
