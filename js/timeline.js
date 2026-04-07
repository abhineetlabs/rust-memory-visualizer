/**
 * Execution Timeline
 *
 * Displays step-by-step memory operations with playback controls.
 * Each step shows what memory action occurs and in which segment.
 */

const ExecutionTimeline = (() => {

  let entriesContainer = null;
  let stepDisplay = null;
  let prevBtn = null;
  let nextBtn = null;
  let playBtn = null;

  let steps = [];
  let currentStep = -1;  // -1 = no step selected (show all)
  let isPlaying = false;
  let playInterval = null;

  let onStepChange = null; // callback: (step, entry) => void

  const SEGMENT_TAGS = {
    stack: 'tag-stack',
    heap: 'tag-heap',
    rodata: 'tag-rodata',
    data: 'tag-data',
    bss: 'tag-bss',
    text: 'tag-text',
    drop: 'tag-drop',
  };

  /**
   * Initialize timeline
   */
  function init(config) {
    entriesContainer = document.getElementById('timeline-entries');
    stepDisplay = document.getElementById('timeline-step-display');
    prevBtn = document.getElementById('timeline-prev');
    nextBtn = document.getElementById('timeline-next');
    playBtn = document.getElementById('timeline-play');

    onStepChange = config.onStepChange || (() => {});

    // Wire up controls
    prevBtn?.addEventListener('click', () => goToStep(currentStep - 1));
    nextBtn?.addEventListener('click', () => goToStep(currentStep + 1));
    playBtn?.addEventListener('click', togglePlay);
  }

  /**
   * Render timeline entries
   */
  function render(timeline) {
    if (!entriesContainer) return;
    steps = timeline || [];
    currentStep = -1;
    isPlaying = false;

    entriesContainer.innerHTML = '';

    if (steps.length === 0) {
      entriesContainer.innerHTML = '<div class="timeline-placeholder">No steps to display</div>';
      updateControls();
      return;
    }

    for (const step of steps) {
      const entry = document.createElement('div');
      entry.className = 'timeline-entry';
      entry.dataset.step = step.step;
      entry.dataset.segment = step.segment;
      entry.dataset.entryId = step.entryId || '';
      entry.dataset.line = step.line || '';

      const stepNum = document.createElement('span');
      stepNum.className = 'timeline-step-num';
      stepNum.textContent = step.step;

      const action = document.createElement('span');
      action.className = 'timeline-action';

      const tagClass = SEGMENT_TAGS[step.segment] || 'tag-stack';
      const segLabel = step.segment === 'drop' ? 'DROP' :
                       step.segment === 'stack' ? 'STACK' :
                       step.segment === 'heap' ? 'HEAP' :
                       step.segment === 'rodata' ? '.RODATA' :
                       step.segment === 'data' ? '.DATA' :
                       step.segment === 'bss' ? '.BSS' :
                       step.segment === 'text' ? '.TEXT' : step.segment.toUpperCase();

      action.innerHTML = `${escapeHTML(step.action)} <span class="timeline-segment-tag ${tagClass}">${segLabel}</span>`;

      if (step.detail) {
        const detail = document.createElement('div');
        detail.style.fontSize = '11px';
        detail.style.color = '#64748b';
        detail.style.marginTop = '2px';
        detail.textContent = step.detail;
        action.appendChild(detail);
      }

      entry.appendChild(stepNum);
      entry.appendChild(action);

      entry.addEventListener('click', () => {
        goToStep(step.step - 1);
      });

      entry.addEventListener('mouseenter', () => {
        if (step.entryId) {
          onStepChange(step, true);
        }
      });

      entry.addEventListener('mouseleave', () => {
        if (step.entryId) {
          onStepChange(step, false);
        }
      });

      entriesContainer.appendChild(entry);
    }

    updateControls();
  }

  /**
   * Navigate to a specific step
   */
  function goToStep(idx) {
    if (idx < -1) idx = -1;
    if (idx >= steps.length) idx = steps.length - 1;

    // Clear previous highlights
    const allEntries = entriesContainer?.querySelectorAll('.timeline-entry') || [];
    allEntries.forEach(e => e.classList.remove('active'));

    currentStep = idx;

    if (idx >= 0 && idx < steps.length) {
      const step = steps[idx];

      // Highlight current entry
      allEntries.forEach(e => {
        if (parseInt(e.dataset.step) === step.step) {
          e.classList.add('active');
          e.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });

      // Notify callback
      onStepChange(step, true);
    }

    updateControls();
  }

  /**
   * Toggle auto-play
   */
  function togglePlay() {
    if (isPlaying) {
      stopPlay();
    } else {
      startPlay();
    }
  }

  function startPlay() {
    isPlaying = true;
    playBtn?.classList.add('playing');

    if (currentStep < 0 || currentStep >= steps.length - 1) {
      currentStep = -1;
    }

    playInterval = setInterval(() => {
      if (currentStep >= steps.length - 1) {
        stopPlay();
        return;
      }
      goToStep(currentStep + 1);
    }, 1200);

    updateControls();
  }

  function stopPlay() {
    isPlaying = false;
    playBtn?.classList.remove('playing');
    if (playInterval) {
      clearInterval(playInterval);
      playInterval = null;
    }
    updateControls();
  }

  /**
   * Update control states
   */
  function updateControls() {
    const hasSteps = steps.length > 0;

    if (prevBtn) prevBtn.disabled = !hasSteps || currentStep <= 0;
    if (nextBtn) nextBtn.disabled = !hasSteps || currentStep >= steps.length - 1;
    if (playBtn) playBtn.disabled = !hasSteps;

    if (stepDisplay) {
      if (currentStep >= 0) {
        stepDisplay.textContent = `${currentStep + 1} / ${steps.length}`;
      } else {
        stepDisplay.textContent = hasSteps ? `- / ${steps.length}` : '-';
      }
    }
  }

  /**
   * Get current step data
   */
  function getCurrentStep() {
    if (currentStep >= 0 && currentStep < steps.length) {
      return steps[currentStep];
    }
    return null;
  }

  /**
   * Escape HTML for safe insertion
   */
  function escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Public API
  return {
    init,
    render,
    goToStep,
    togglePlay,
    stopPlay,
    getCurrentStep,
  };

})();
