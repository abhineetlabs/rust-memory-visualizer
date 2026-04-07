/**
 * App — Main orchestration
 *
 * Wires together the code editor, analyzer, visualizer, and timeline.
 */

(function () {
  'use strict';

  // ==========================================
  // State
  // ==========================================

  let editor = null;
  let currentAnalysis = null;
  let highlightedLines = [];

  // ==========================================
  // Initialization
  // ==========================================

  document.addEventListener('DOMContentLoaded', () => {
    initEditor();
    initVisualizer();
    initTimeline();
    initExamples();
    initResizeHandle();
    initTimelineResize();
    initHelp();
    initKeyboard();

    // Load default example
    if (RustExamples && RustExamples.length > 0) {
      loadExample(RustExamples[0]);
    }
  });

  // ==========================================
  // Editor
  // ==========================================

  function initEditor() {
    const editorEl = document.getElementById('code-editor');
    if (!editorEl) return;

    editor = CodeMirror(editorEl, {
      mode: 'rust',
      theme: 'dracula',
      lineNumbers: true,
      indentUnit: 4,
      tabSize: 4,
      indentWithTabs: false,
      lineWrapping: false,
      matchBrackets: true,
      autoCloseBrackets: true,
      placeholder: 'Paste your Rust code here...',
      extraKeys: {
        'Ctrl-Enter': runAnalysis,
        'Cmd-Enter': runAnalysis,
      },
    });

    // Track cursor position for line highlighting
    editor.on('cursorActivity', () => {
      const line = editor.getCursor().line + 1; // 1-indexed
      highlightVizByLine(line);
    });

    // Analyze button
    const analyzeBtn = document.getElementById('analyze-btn');
    analyzeBtn?.addEventListener('click', runAnalysis);
  }

  // ==========================================
  // Visualizer
  // ==========================================

  function initVisualizer() {
    const svgEl = document.getElementById('memory-svg');
    if (!svgEl) return;

    MemoryVisualizer.init(svgEl, {
      onHoverEntry: handleVizHover,
      onClickEntry: handleVizClick,
    });
  }

  function handleVizHover(entry, isHovering) {
    if (!editor) return;

    // Clear previous highlights
    clearEditorHighlights();

    if (isHovering && entry.line) {
      highlightEditorLine(entry.line, entry.segment);
    }
  }

  function handleVizClick(entry, event) {
    if (!entry) return;

    // Show tooltip
    showTooltip(entry, event);

    // Jump to line in editor
    if (editor && entry.line) {
      editor.setCursor({ line: entry.line - 1, ch: 0 });
      editor.scrollIntoView({ line: entry.line - 1, ch: 0 }, 100);
    }
  }

  function highlightVizByLine(lineNum) {
    MemoryVisualizer.highlightByLine(lineNum, true);

    // Auto-clear after a short delay if cursor moves
    setTimeout(() => {
      MemoryVisualizer.highlightByLine(lineNum, false);
    }, 2000);
  }

  // ==========================================
  // Timeline
  // ==========================================

  function initTimeline() {
    ExecutionTimeline.init({
      onStepChange: handleTimelineStep,
    });
  }

  function handleTimelineStep(step, isActive) {
    if (!step) return;

    if (!isActive) {
      if (step.entryId) {
        MemoryVisualizer.highlightById(step.entryId, false);
      }
      clearEditorHighlights();
      return;
    }

    // Activating — clear everything first, then highlight new step
    MemoryVisualizer.clearHighlights();
    clearEditorHighlights();

    if (step.entryId) {
      MemoryVisualizer.highlightById(step.entryId, true);
    }

    if (step.line) {
      highlightEditorLine(step.line, step.segment);
    }

    // Move RSP to reflect current execution state
    if (currentAnalysis) {
      const stepIndex = step.step - 1; // timeline steps are 1-indexed
      MemoryVisualizer.updateForStep(stepIndex, currentAnalysis.timeline);
    }
  }

  // ==========================================
  // Analysis
  // ==========================================

  function runAnalysis() {
    if (!editor) return;

    const source = editor.getValue();
    if (!source.trim()) return;

    try {
      currentAnalysis = RustAnalyzer.analyze(source);

      // Show viz panel
      const placeholder = document.getElementById('viz-placeholder');
      const content = document.getElementById('viz-content');
      if (placeholder) placeholder.classList.add('hidden');
      if (content) content.classList.remove('hidden');

      // Render visualization
      MemoryVisualizer.render(currentAnalysis);

      // Render timeline
      ExecutionTimeline.render(currentAnalysis.timeline);

    } catch (err) {
      console.error('Analysis failed:', err);

      // Show error in timeline
      const timelineEntries = document.getElementById('timeline-entries');
      if (timelineEntries) {
        timelineEntries.innerHTML = `<div class="timeline-placeholder" style="color: #ef4444;">
          Analysis error: ${escapeHTML(err.message)}. The code may have syntax not yet supported.
        </div>`;
      }
    }
  }

  // ==========================================
  // Examples
  // ==========================================

  function initExamples() {
    const btn = document.getElementById('examples-btn');
    const menu = document.getElementById('examples-menu');
    if (!btn || !menu) return;

    // Populate examples
    for (const example of RustExamples) {
      const item = document.createElement('button');
      item.className = 'dropdown-item';
      item.innerHTML = `
        <div class="item-title">${escapeHTML(example.title)}</div>
        <div class="item-desc">${escapeHTML(example.description)}</div>
      `;
      item.addEventListener('click', () => {
        loadExample(example);
        menu.classList.add('hidden');
      });
      menu.appendChild(item);
    }

    // Toggle dropdown
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.toggle('hidden');
    });

    // Close dropdown on outside click
    document.addEventListener('click', () => {
      menu.classList.add('hidden');
    });
  }

  function loadExample(example) {
    if (!editor || !example) return;
    editor.setValue(example.code);
    // Auto-analyze
    setTimeout(runAnalysis, 100);
  }

  // ==========================================
  // Resize Handle
  // ==========================================

  function initResizeHandle() {
    const handle = document.getElementById('resize-handle');
    const editorPanel = document.getElementById('editor-panel');
    const main = document.getElementById('app-main');
    if (!handle || !editorPanel || !main) return;

    let isResizing = false;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const mainRect = main.getBoundingClientRect();
      const newWidth = e.clientX - mainRect.left;
      const minWidth = 300;
      const maxWidth = mainRect.width - 300;

      if (newWidth >= minWidth && newWidth <= maxWidth) {
        editorPanel.style.width = newWidth + 'px';
        // Refresh editor layout
        if (editor) editor.refresh();
        // Re-render viz if analysis exists
        if (currentAnalysis) {
          MemoryVisualizer.render(currentAnalysis);
        }
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // ==========================================
  // Timeline Resize Handle (vertical)
  // ==========================================

  function initTimelineResize() {
    const handle = document.getElementById('timeline-resize-handle');
    const timelinePanel = document.getElementById('timeline-panel');
    if (!handle || !timelinePanel) return;

    let isResizing = false;

    handle.addEventListener('mousedown', (e) => {
      isResizing = true;
      handle.classList.add('active');
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;
      const windowH = window.innerHeight;
      const newHeight = windowH - e.clientY;
      const minH = 60;
      const maxH = windowH * 0.5;

      if (newHeight >= minH && newHeight <= maxH) {
        timelinePanel.style.height = newHeight + 'px';
        if (editor) editor.refresh();
        if (currentAnalysis) MemoryVisualizer.render(currentAnalysis);
      }
    });

    document.addEventListener('mouseup', () => {
      if (isResizing) {
        isResizing = false;
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }
    });
  }

  // ==========================================
  // Help Modal
  // ==========================================

  function initHelp() {
    const helpBtn = document.getElementById('help-btn');
    const modal = document.getElementById('help-modal');
    const closeBtn = modal?.querySelector('.modal-close');

    helpBtn?.addEventListener('click', () => {
      modal?.classList.remove('hidden');
    });

    closeBtn?.addEventListener('click', () => {
      modal?.classList.add('hidden');
    });

    modal?.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.classList.add('hidden');
      }
    });
  }

  // ==========================================
  // Keyboard Shortcuts
  // ==========================================

  function initKeyboard() {
    document.addEventListener('keydown', (e) => {
      // Escape: close modals
      if (e.key === 'Escape') {
        document.getElementById('help-modal')?.classList.add('hidden');
        document.getElementById('examples-menu')?.classList.add('hidden');
      }

      // Arrow keys for timeline (when not focused on editor)
      if (document.activeElement?.closest('#code-editor')) return;

      if (e.key === 'ArrowLeft') {
        const current = ExecutionTimeline.getCurrentStep();
        if (current) {
          ExecutionTimeline.goToStep(current.step - 2); // -2 because step is 1-indexed
        }
      }

      if (e.key === 'ArrowRight') {
        const current = ExecutionTimeline.getCurrentStep();
        const nextIdx = current ? current.step : 0; // step is 1-indexed
        ExecutionTimeline.goToStep(nextIdx);
      }

      if (e.key === ' ' && !document.activeElement?.closest('#code-editor')) {
        e.preventDefault();
        ExecutionTimeline.togglePlay();
      }
    });
  }

  // ==========================================
  // Editor Line Highlighting
  // ==========================================

  function highlightEditorLine(lineNum, segment) {
    if (!editor) return;
    const line = lineNum - 1; // CodeMirror is 0-indexed
    if (line < 0 || line >= editor.lineCount()) return;

    const className = `cm-highlight-${segment || 'line'}`;
    const handle = editor.addLineClass(line, 'background', className);
    highlightedLines.push({ line, handle, className });
  }

  function clearEditorHighlights() {
    if (!editor) return;
    for (const hl of highlightedLines) {
      editor.removeLineClass(hl.line, 'background', hl.className);
    }
    highlightedLines = [];
  }

  // ==========================================
  // Tooltip
  // ==========================================

  function showTooltip(entry, event) {
    const tooltip = document.getElementById('tooltip');
    if (!tooltip) return;

    const header = tooltip.querySelector('.tooltip-header');
    const body = tooltip.querySelector('.tooltip-body');

    const segColor = MemoryVisualizer.SEGMENTS[entry.segment]?.color || '#fff';

    header.innerHTML = `<span style="color:${segColor}">${escapeHTML(entry.name)}</span>`;

    let bodyHTML = '';
    bodyHTML += `<div class="tip-row"><span class="tip-label">Segment</span><span class="tip-value" style="color:${segColor}">${entry.segment}</span></div>`;
    bodyHTML += `<div class="tip-row"><span class="tip-label">Type</span><span class="tip-value">${escapeHTML(entry.type)}</span></div>`;
    if (entry.size) {
      bodyHTML += `<div class="tip-row"><span class="tip-label">Size</span><span class="tip-value">${entry.size} bytes</span></div>`;
    }
    if (entry.line) {
      bodyHTML += `<div class="tip-row"><span class="tip-label">Line</span><span class="tip-value">${entry.line}</span></div>`;
    }
    if (entry.reason) {
      bodyHTML += `<div class="tip-reason">${escapeHTML(entry.reason)}</div>`;
    }

    body.innerHTML = bodyHTML;

    // Position tooltip
    tooltip.classList.remove('hidden');
    const rect = tooltip.getBoundingClientRect();
    let x = event.clientX + 12;
    let y = event.clientY - 10;

    if (x + rect.width > window.innerWidth) x = event.clientX - rect.width - 12;
    if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 10;
    if (y < 0) y = 10;

    tooltip.style.left = x + 'px';
    tooltip.style.top = y + 'px';

    // Dismiss on next click anywhere outside the tooltip
    clearTimeout(tooltip._hideTimer);
    // Fallback auto-hide in case user doesn't click
    tooltip._hideTimer = setTimeout(() => {
      tooltip.classList.add('hidden');
    }, 8000);

    // Use a one-shot listener so it cleans itself up
    function dismissOnClick(e) {
      // Small delay so the current click doesn't immediately dismiss
      setTimeout(() => {
        tooltip.classList.add('hidden');
        clearTimeout(tooltip._hideTimer);
      }, 0);
      document.removeEventListener('click', dismissOnClick, true);
    }
    // Remove any previous listener first
    if (tooltip._dismissFn) {
      document.removeEventListener('click', tooltip._dismissFn, true);
    }
    tooltip._dismissFn = dismissOnClick;
    // Attach on next tick so the current click event doesn't trigger it
    setTimeout(() => {
      document.addEventListener('click', dismissOnClick, true);
    }, 0);
  }

  // ==========================================
  // Utilities
  // ==========================================

  function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

})();
