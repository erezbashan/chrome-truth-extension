/**
 * YouTube Truth Bar — Content Script (Runs in ISOLATED world)
 *
 * Manages:
 *  - Injecting the Top Bar, Timeline Markers, and Expandable Drawer above the YouTube player
 *  - Requesting Closed Captions (CC) from page-bridge.js
 *  - Playback-first chunk scheduling in parallel with video playback
 *  - Real-time 60fps synchronization of the live bar with video currentTime + 10s linger buffer
 */
(() => {
  if (window.__ytTruthContentInitialized) return;
  window.__ytTruthContentInitialized = true;

  const STATE = {
    videoId: null,
    metadata: null,
    languageCode: 'en',
    hasCaptions: false,
    segments: [],
    chunks: [], // Array of { index, startTime, endTime, segments }
    analyzedChunks: {}, // chunkIndex -> chunkResult
    isVideoRelevant: true,
    irrelevantReason: '',
    isAnalyzing: false,
    isPaused: false,
    error: null,
    missingApiKey: false,
    drawerOpen: false,
    activeFilter: 'ALL', // 'ALL' | 'FALSE' | 'QUESTIONABLE' | 'TRUE'
    activeClaimId: null,
    settings: {
      version: '1.0.5',
      hasApiKey: false,
      maskedKey: '',
      geminiModel: 'gemini-3.8-flash',
      enableSearchGrounding: true,
      autoCheck: true,
      chunkDurationSec: 900,
      lookaheadBufferSec: 60,
      lingerDurationSec: 10
    }
  };

  let rootEl = null;
  let videoEl = null;
  let currentRunToken = 0;
  let pendingRequests = new Map();
  let reqCounter = 0;
  let rafPending = false;
  let ttPolicy = null;

  /**
   * Safe HTML setter compatible with YouTube's TrustedTypes CSP
   */
  function setSafeHtml(el, html) {
    if (!el) return;
    try {
      if (window.trustedTypes && window.trustedTypes.createPolicy) {
        if (!ttPolicy) {
          ttPolicy = window.trustedTypes.createPolicy('ytTruthBarPolicy', {
            createHTML: (s) => s
          });
        }
        el.innerHTML = ttPolicy.createHTML(html);
        return;
      }
    } catch {
      // Fallback below if policy creation is restricted
    }
    el.innerHTML = html;
  }

  // Listen for responses from page-bridge.js (MAIN world)
  window.addEventListener('YT_TRUTH_VIDEO_DATA_RESULT', (event) => {
    const detail = event.detail || {};
    const resolver = pendingRequests.get(detail.requestId);
    if (resolver) {
      pendingRequests.delete(detail.requestId);
      resolver(detail);
    }
  });

  // Listen for progressive Step 1 & Step 2 updates from background service worker
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'CHUNK_UPDATED' && message.videoId === STATE.videoId) {
      if (message.chunkResult) {
        STATE.analyzedChunks[message.chunkIndex] = message.chunkResult;
      }
      if (message.videoCache) {
        STATE.isVideoRelevant = message.videoCache.isVideoRelevant !== false;
        STATE.irrelevantReason = message.videoCache.irrelevantReason || '';
      }
      scheduleRender();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'SETTINGS_UPDATED') {
      refreshSettingsAndMaybeRestart();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function fetchVideoDataFromBridge(videoId) {
    return new Promise((resolve) => {
      const requestId = `req_${++reqCounter}_${Date.now()}`;
      const timeout = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
          pendingRequests.delete(requestId);
          resolve({ success: false, error: 'Timed out reading YouTube player data' });
        }
      }, 12000);

      pendingRequests.set(requestId, (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      window.dispatchEvent(
        new CustomEvent('YT_TRUTH_FETCH_VIDEO_DATA', {
          detail: { requestId, videoId }
        })
      );
    });
  }

  function seekToSeconds(seconds) {
    window.dispatchEvent(
      new CustomEvent('YT_TRUTH_SEEK_TO', {
        detail: { seconds }
      })
    );
  }

  function getWatchVideoId() {
    try {
      const url = new URL(window.location.href);
      if (url.pathname === '/watch') {
        return url.searchParams.get('v');
      }
      return null;
    } catch {
      return null;
    }
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (hrs > 0) {
      return `${hrs}:${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  }

  /**
   * Ensure #yt-truth-root is mounted directly above the YouTube video player
   * in Default, Theater, and Fullscreen modes.
   */
  function ensureRootMounted() {
    if (!getWatchVideoId()) {
      if (rootEl && rootEl.parentNode) {
        rootEl.parentNode.removeChild(rootEl);
      }
      return null;
    }

    if (!rootEl) {
      rootEl = createRootDom();
    }

    const fsEl = document.fullscreenElement;
    if (fsEl) {
      rootEl.classList.add('yt-truth-fullscreen');
      if (rootEl.parentNode !== fsEl) {
        fsEl.prepend(rootEl);
      }
      return rootEl;
    }

    rootEl.classList.remove('yt-truth-fullscreen');

    const watchFlexy = document.querySelector('ytd-watch-flexy');
    const isTheater = watchFlexy && watchFlexy.hasAttribute('theater');

    if (isTheater) {
      const fullBleed =
        document.getElementById('full-bleed-container') ||
        document.getElementById('player-full-bleed-container') ||
        document.getElementById('player-theater-container');
      if (fullBleed && fullBleed.parentNode) {
        if (rootEl.nextSibling !== fullBleed) {
          fullBleed.parentNode.insertBefore(rootEl, fullBleed);
        }
        return rootEl;
      }
    }

    // Standard mode: insert right above #player inside #primary-inner
    const playerEl =
      document.querySelector('#primary-inner > #player') ||
      document.getElementById('player-container-outer') ||
      document.getElementById('player');

    if (playerEl && playerEl.parentNode) {
      if (rootEl.nextSibling !== playerEl) {
        playerEl.parentNode.insertBefore(rootEl, playerEl);
      }
      return rootEl;
    }

    return null;
  }

  function createRootDom() {
    const container = document.createElement('div');
    container.id = 'yt-truth-root';

    setSafeHtml(container, `
      <div class="yt-truth-bar state-idle" id="yt-truth-bar">
        <div class="yt-truth-bar-main">
          <div class="yt-truth-grade-section" id="yt-truth-grade-section">
            <span class="yt-truth-brand-dot"></span>
            <span class="yt-truth-relevance-pill" id="yt-truth-relevance-pill" title="Percentage of video containing verifiable factual claims">
              Analyzing...
            </span>
            <span class="yt-truth-score-pill" id="yt-truth-score-pill" title="Overall accuracy score across verified claims">
              <span class="yt-truth-score-value" id="yt-truth-score-value">—</span>
              <span class="yt-truth-counters" id="yt-truth-counters"></span>
            </span>
          </div>

          <div class="yt-truth-live-section" id="yt-truth-live-section" dir="auto">
            <span class="yt-truth-verdict-badge" id="yt-truth-verdict-badge" style="display:none;"></span>
            <span class="yt-truth-live-time" id="yt-truth-live-time" style="display:none;"></span>
            <div class="yt-truth-live-text-wrap">
              <div class="yt-truth-live-claim" id="yt-truth-live-claim">Initializing YouTube Truth Bar...</div>
              <div class="yt-truth-live-explanation" id="yt-truth-live-explanation"></div>
            </div>
            <span class="yt-truth-searching-pill" id="yt-truth-searching-pill" style="display:none;">
              🔍 Web Verifying...
            </span>
          </div>

          <div class="yt-truth-right-section">
            <span class="yt-truth-version-badge" id="yt-truth-version-badge" title="Extension Build Version">v1.0.5</span>
            <span class="yt-truth-progress-badge" id="yt-truth-progress-badge">
              <span class="yt-truth-spinner" id="yt-truth-spinner"></span>
              <span id="yt-truth-progress-text">Starting</span>
            </span>
            <button type="button" class="yt-truth-expand-btn" id="yt-truth-expand-btn">
              ▼ Claims
            </button>
          </div>
        </div>

        <div class="yt-truth-timeline" id="yt-truth-timeline">
          <div id="yt-truth-timeline-chunks"></div>
          <div id="yt-truth-timeline-ticks"></div>
          <div class="yt-truth-timeline-playhead" id="yt-truth-timeline-playhead" style="left: 0%;"></div>
        </div>
      </div>

      <div class="yt-truth-drawer hidden" id="yt-truth-drawer">
        <div class="yt-truth-key-box hidden" id="yt-truth-key-box">
          <span style="font-size: 12px; color: #bfdbfe; font-weight: 600;">
            🔑 Enter your Gemini API Key (or set GEMINI_API_KEY in config.js):
          </span>
          <input type="password" class="yt-truth-key-input" id="yt-truth-key-input" placeholder="AIzaSy..." />
          <button type="button" class="yt-truth-action-btn" id="yt-truth-save-key-btn">Save & Check Video</button>
        </div>

        <div class="yt-truth-drawer-header">
          <div class="yt-truth-drawer-summary" id="yt-truth-drawer-summary" dir="auto">
            Waiting for transcript analysis...
          </div>
          <div class="yt-truth-drawer-controls">
            <div class="yt-truth-filter-group" id="yt-truth-filter-group">
              <button type="button" class="yt-truth-filter-btn active" data-filter="ALL">All</button>
              <button type="button" class="yt-truth-filter-btn" data-filter="FALSE">✗ False</button>
              <button type="button" class="yt-truth-filter-btn" data-filter="QUESTIONABLE">⚠ Questionable</button>
              <button type="button" class="yt-truth-filter-btn" data-filter="TRUE">✓ True</button>
            </div>
            <button type="button" class="yt-truth-action-btn" id="yt-truth-pause-btn">⏸ Pause</button>
            <button type="button" class="yt-truth-action-btn" id="yt-truth-recheck-btn">↻ Re-check</button>
          </div>
        </div>

        <div class="yt-truth-claims-list" id="yt-truth-claims-list" dir="auto"></div>
      </div>
    `);

    // Toggle drawer when clicking the bar
    const barEl = container.querySelector('#yt-truth-bar');
    barEl.addEventListener('click', (e) => {
      if (e.target.closest('.yt-truth-timeline-tick')) return;
      STATE.drawerOpen = !STATE.drawerOpen;
      scheduleRender();
    });

    // Filter buttons inside drawer
    const filterGroup = container.querySelector('#yt-truth-filter-group');
    filterGroup.addEventListener('click', (e) => {
      const btn = e.target.closest('.yt-truth-filter-btn');
      if (!btn) return;
      e.stopPropagation();
      STATE.activeFilter = btn.getAttribute('data-filter') || 'ALL';
      scheduleRender();
    });

    // Pause / Resume button
    const pauseBtn = container.querySelector('#yt-truth-pause-btn');
    pauseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.isPaused = !STATE.isPaused;
      if (!STATE.isPaused) {
        maybeAnalyzeCurrentWindow(currentRunToken);
      }
      scheduleRender();
    });

    // Re-check video button
    const recheckBtn = container.querySelector('#yt-truth-recheck-btn');
    recheckBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!STATE.videoId) return;
      await chrome.runtime.sendMessage({
        type: 'CLEAR_VIDEO_CACHE',
        videoId: STATE.videoId
      });
      STATE.analyzedChunks = {};
      STATE.isVideoRelevant = true;
      STATE.irrelevantReason = '';
      STATE.isPaused = false;
      STATE.error = null;
      scheduleRender();
      maybeAnalyzeCurrentWindow(++currentRunToken);
    });

    // Save API key button inside drawer
    const saveKeyBtn = container.querySelector('#yt-truth-save-key-btn');
    saveKeyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const input = container.querySelector('#yt-truth-key-input');
      const val = (input?.value || '').trim();
      if (!val) return;
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        settings: { customApiKey: val }
      });
      STATE.missingApiKey = false;
      STATE.error = null;
      await refreshSettingsAndMaybeRestart();
    });

    // Delegate click on timeline ticks and claim card seek buttons
    container.addEventListener('click', (e) => {
      const tick = e.target.closest('.yt-truth-timeline-tick');
      if (tick) {
        e.stopPropagation();
        const sec = parseFloat(tick.getAttribute('data-start') || '0');
        seekToSeconds(sec);
        return;
      }

      const seekBtn = e.target.closest('.yt-truth-seek-btn');
      if (seekBtn) {
        e.stopPropagation();
        const sec = parseFloat(seekBtn.getAttribute('data-start') || '0');
        seekToSeconds(sec);
      }
    });

    return container;
  }

  /**
   * Group transcript segments into ~3.5-minute chunks so Gemini checks EVERY claim
   */
  function buildTranscriptChunks(segments, chunkDurationSec) {
    if (!Array.isArray(segments) || segments.length === 0) return [];
    const chunks = [];
    let currentSegments = [];
    let chunkStart = segments[0].start;
    let chunkIndex = 0;

    for (const seg of segments) {
      if (currentSegments.length > 0 && seg.start - chunkStart >= chunkDurationSec) {
        const lastSeg = currentSegments[currentSegments.length - 1];
        chunks.push({
          index: chunkIndex++,
          startTime: chunkStart,
          endTime: lastSeg.end,
          segments: currentSegments
        });
        currentSegments = [seg];
        chunkStart = seg.start;
      } else {
        currentSegments.push(seg);
      }
    }

    if (currentSegments.length > 0) {
      const lastSeg = currentSegments[currentSegments.length - 1];
      chunks.push({
        index: chunkIndex,
        startTime: chunkStart,
        endTime: lastSeg.end,
        segments: currentSegments
      });
    }

    return chunks;
  }

  /**
   * Flatten all claims across analyzed chunks, sorted by startTime
   */
  function getAllClaims() {
    const all = [];
    for (const ch of Object.values(STATE.analyzedChunks)) {
      if (ch && Array.isArray(ch.claims)) {
        for (const claim of ch.claims) {
          all.push(claim);
        }
      }
    }
    return all.sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * Compute General Video Grade metrics:
   *  - relevancePct: average factual content % across checked chunks
   *  - accuracyPct: weighted truth score across all verified claims
   *  - counts of TRUE, QUESTIONABLE, FALSE
   */
  function computeMetrics() {
    const chunkValues = Object.values(STATE.analyzedChunks);
    const checkedCount = chunkValues.length;
    const totalChunks = STATE.chunks.length;

    if (!STATE.isVideoRelevant) {
      return {
        isRelevant: false,
        relevancePct: 0,
        accuracyPct: null,
        trueCount: 0,
        questionableCount: 0,
        falseCount: 0,
        totalClaims: 0,
        checkedCount,
        totalChunks
      };
    }

    let sumFactualPct = 0;
    for (const ch of chunkValues) {
      sumFactualPct += typeof ch.chunkFactualPercentage === 'number' ? ch.chunkFactualPercentage : 0;
    }
    const relevancePct =
      checkedCount > 0 ? Math.round(sumFactualPct / checkedCount) : null;

    const claims = getAllClaims();
    let trueCount = 0;
    let questionableCount = 0;
    let falseCount = 0;

    for (const c of claims) {
      if (c.verdict === 'TRUE') trueCount++;
      else if (c.verdict === 'QUESTIONABLE') questionableCount++;
      else if (c.verdict === 'FALSE') falseCount++;
    }

    const totalClaims = claims.length;
    let accuracyPct = null;
    if (totalClaims > 0) {
      const weightedPoints = trueCount * 1.0 + questionableCount * 0.4;
      accuracyPct = Math.round((weightedPoints / totalClaims) * 100);
    }

    return {
      isRelevant: true,
      relevancePct,
      accuracyPct,
      trueCount,
      questionableCount,
      falseCount,
      totalClaims,
      checkedCount,
      totalChunks
    };
  }

  /**
   * Determine which claim (if any) should be shown on the live bar right now
   * using [claim.startTime - 0.3, claim.endTime + lingerDurationSec]
   */
  function findActiveClaimAtTime(currentTime) {
    const linger = STATE.settings.lingerDurationSec || 10;
    const claims = getAllClaims();
    const candidates = claims.filter(
      (c) => currentTime >= c.startTime - 0.3 && currentTime <= c.endTime + linger
    );
    if (candidates.length === 0) return null;

    // Prefer claims currently being spoken right now, otherwise highest severity / latest start
    const severityRank = { FALSE: 3, QUESTIONABLE: 2, TRUE: 1 };
    candidates.sort((a, b) => {
      const aSpeaking = currentTime <= a.endTime + 1.5 ? 1 : 0;
      const bSpeaking = currentTime <= b.endTime + 1.5 ? 1 : 0;
      if (aSpeaking !== bSpeaking) return bSpeaking - aSpeaking;
      const sevDiff = (severityRank[b.verdict] || 0) - (severityRank[a.verdict] || 0);
      if (sevDiff !== 0) return sevDiff;
      return b.startTime - a.startTime;
    });

    return candidates[0];
  }

  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      renderUI();
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderUI() {
    const mounted = ensureRootMounted();
    if (!mounted) return;

    const barEl = mounted.querySelector('#yt-truth-bar');
    const relevancePill = mounted.querySelector('#yt-truth-relevance-pill');
    const scorePill = mounted.querySelector('#yt-truth-score-pill');
    const scoreValEl = mounted.querySelector('#yt-truth-score-value');
    const countersEl = mounted.querySelector('#yt-truth-counters');
    const verdictBadge = mounted.querySelector('#yt-truth-verdict-badge');
    const liveTimeEl = mounted.querySelector('#yt-truth-live-time');
    const liveClaimEl = mounted.querySelector('#yt-truth-live-claim');
    const liveExpEl = mounted.querySelector('#yt-truth-live-explanation');
    const searchingPill = mounted.querySelector('#yt-truth-searching-pill');
    const progressBadge = mounted.querySelector('#yt-truth-progress-badge');
    const spinnerEl = mounted.querySelector('#yt-truth-spinner');
    const progressTextEl = mounted.querySelector('#yt-truth-progress-text');
    const expandBtn = mounted.querySelector('#yt-truth-expand-btn');
    const versionBadge = mounted.querySelector('#yt-truth-version-badge');
    if (versionBadge && STATE.settings?.version) {
      versionBadge.textContent = `v${STATE.settings.version}`;
    }
    const drawerEl = mounted.querySelector('#yt-truth-drawer');
    const keyBoxEl = mounted.querySelector('#yt-truth-key-box');
    const pauseBtn = mounted.querySelector('#yt-truth-pause-btn');

    const currentTime = videoEl ? videoEl.currentTime || 0 : 0;
    const duration =
      (videoEl && videoEl.duration && Number.isFinite(videoEl.duration)
        ? videoEl.duration
        : STATE.metadata?.lengthSeconds) || 0;

    // Update playhead on timeline
    const playheadEl = mounted.querySelector('#yt-truth-timeline-playhead');
    if (playheadEl && duration > 0) {
      const pct = Math.max(0, Math.min(100, (currentTime / duration) * 100));
      playheadEl.style.left = `${pct}%`;
    }

    const metrics = computeMetrics();
    const activeClaim = findActiveClaimAtTime(currentTime);
    STATE.activeClaimId = activeClaim ? activeClaim.id : null;

    // 1. Missing API key state
    if (STATE.missingApiKey) {
      barEl.className = 'yt-truth-bar state-calm-yellow';
      relevancePill.textContent = 'Setup Needed';
      scoreValEl.textContent = 'API Key';
      scoreValEl.className = 'yt-truth-score-value score-mid';
      setSafeHtml(countersEl, '');
      verdictBadge.style.display = 'none';
      liveTimeEl.style.display = 'none';
      liveClaimEl.textContent =
        'Gemini API key not set — Click here to paste your key or set GEMINI_API_KEY in config.js';
      liveExpEl.textContent = '';
      searchingPill.style.display = 'none';
      spinnerEl.style.display = 'none';
      progressTextEl.textContent = 'Waiting for key';
      keyBoxEl.classList.remove('hidden');
    } else {
      keyBoxEl.classList.add('hidden');
    }

    // 2. No Captions available state
    if (!STATE.missingApiKey && !STATE.hasCaptions && !STATE.isAnalyzing && STATE.chunks.length === 0) {
      barEl.className = 'yt-truth-bar state-na';
      relevancePill.textContent = 'Fact Check: N/A';
      scoreValEl.textContent = 'No CC';
      scoreValEl.className = 'yt-truth-score-value';
      setSafeHtml(countersEl, '');
      verdictBadge.style.display = 'none';
      liveTimeEl.style.display = 'none';
      liveClaimEl.textContent =
        STATE.error || 'No Closed Captions (CC) found on this video — cannot extract claims.';
      liveExpEl.textContent = '';
      searchingPill.style.display = 'none';
      spinnerEl.style.display = 'none';
      progressTextEl.textContent = 'N/A';
    }

    // 3. Video is Non-Relevant (Music, Fiction, Entertainment, etc.)
    else if (!STATE.missingApiKey && !metrics.isRelevant) {
      barEl.className = 'yt-truth-bar state-na';
      relevancePill.textContent = '0% Factual • N/A';
      scoreValEl.textContent = 'N/A';
      scoreValEl.className = 'yt-truth-score-value';
      setSafeHtml(countersEl, '');
      verdictBadge.style.display = 'none';
      liveTimeEl.style.display = 'none';
      liveClaimEl.textContent = `Not applicable for fact-checking (${
        STATE.irrelevantReason || 'Music / Fiction / Entertainment'
      })`;
      liveExpEl.textContent = 'This video does not make checkable real-world factual assertions.';
      searchingPill.style.display = 'none';
      spinnerEl.style.display = 'none';
      progressTextEl.textContent = 'Skipped (N/A)';
    }

    // 4. Normal Factual Video
    else if (!STATE.missingApiKey) {
      // Update Left General Grade section
      if (metrics.relevancePct !== null) {
        relevancePill.textContent = `${metrics.relevancePct}% Factual`;
      } else {
        relevancePill.textContent = 'Scanning CC...';
      }

      if (metrics.accuracyPct !== null) {
        scoreValEl.textContent = `${metrics.accuracyPct}% True`;
        scoreValEl.className =
          'yt-truth-score-value ' +
          (metrics.accuracyPct >= 80
            ? 'score-high'
            : metrics.accuracyPct >= 55
            ? 'score-mid'
            : 'score-low');
        setSafeHtml(
          countersEl,
          `
          <span class="yt-truth-cnt-true" title="True claims">${metrics.trueCount}✓</span>
          <span class="yt-truth-cnt-warn" title="Questionable claims">${metrics.questionableCount}⚠</span>
          <span class="yt-truth-cnt-false" title="False claims">${metrics.falseCount}✗</span>
        `
        );
      } else if (metrics.checkedCount > 0) {
        scoreValEl.textContent = '100% Clear';
        scoreValEl.className = 'yt-truth-score-value score-high';
        setSafeHtml(countersEl, `<span class="yt-truth-cnt-true">0 disputed</span>`);
      } else {
        scoreValEl.textContent = 'Checking...';
        scoreValEl.className = 'yt-truth-score-value';
        setSafeHtml(countersEl, '');
      }

      // Update Center Live Claim / Status section
      if (activeClaim) {
        const vLower = activeClaim.verdict.toLowerCase();
        barEl.className = `yt-truth-bar state-active-${vLower}`;

        verdictBadge.style.display = 'inline-block';
        verdictBadge.className = `yt-truth-verdict-badge verdict-${vLower}`;
        verdictBadge.textContent =
          activeClaim.verdict === 'TRUE'
            ? '✓ TRUE'
            : activeClaim.verdict === 'FALSE'
            ? '✗ FALSE'
            : '⚠ QUESTIONABLE';

        liveTimeEl.style.display = 'inline-block';
        liveTimeEl.textContent = formatTime(activeClaim.startTime);

        liveClaimEl.textContent = `"${activeClaim.claimText}"`;
        liveExpEl.textContent = activeClaim.explanation;

        searchingPill.style.display = activeClaim.verifyingWithSearch ? 'inline-block' : 'none';
      } else {
        // Calm state between claims — always calm green ("all is well right now")
        // Yellow/Red bar backgrounds are strictly reserved for active questionable/false claims at the current timestamp!
        barEl.className = 'yt-truth-bar state-calm-green';
        verdictBadge.style.display = 'none';
        liveTimeEl.style.display = 'none';
        searchingPill.style.display = 'none';

        if (STATE.error) {
          liveClaimEl.textContent = `Error: ${STATE.error}`;
          liveExpEl.textContent = 'Click Re-check inside drawer to try again.';
        } else if (metrics.checkedCount === 0 && STATE.isAnalyzing) {
          liveClaimEl.textContent = 'Fact-checking video captions around current playback...';
          liveExpEl.textContent = 'Running in parallel — playback is never interrupted.';
        } else {
          liveClaimEl.textContent = `All clear at ${formatTime(
            currentTime
          )} • No active factual claim right now (Opinion / Banter)`;
          liveExpEl.textContent =
            metrics.totalClaims > 0
              ? `${metrics.totalClaims} claims checked so far (${metrics.trueCount} True, ${metrics.questionableCount} Questionable, ${metrics.falseCount} False) — Click bar for full breakdown & sources`
              : 'No disputed claims detected in checked segments so far.';
        }
      }

      // Update Right Progress section
      const currentCov = findCoveringWindow(currentTime);
      if (STATE.isPaused) {
        spinnerEl.style.display = 'none';
        progressTextEl.textContent = `Paused`;
      } else if (STATE.isAnalyzing && STATE.activeWindowRange) {
        spinnerEl.style.display = 'inline-block';
        progressTextEl.textContent = `Checking ${formatTime(
          STATE.activeWindowRange.startTime
        )}–${formatTime(STATE.activeWindowRange.endTime)}`;
      } else if (currentCov) {
        spinnerEl.style.display = 'none';
        progressTextEl.textContent = `✓ Checked ${formatTime(
          currentCov.startTime
        )}–${formatTime(currentCov.endTime)}`;
      } else {
        spinnerEl.style.display = 'none';
        progressTextEl.textContent = `${metrics.checkedCount} window${
          metrics.checkedCount === 1 ? '' : 's'
        } checked`;
      }
    }

    expandBtn.textContent = STATE.drawerOpen
      ? `▲ Hide (${metrics.totalClaims})`
      : `▼ Claims (${metrics.totalClaims})`;

    pauseBtn.textContent = STATE.isPaused ? '▶ Resume' : '⏸ Pause';

    // Render Timeline Chunks & Ticks
    renderTimeline(mounted, duration);

    // Render Drawer if open
    if (STATE.drawerOpen) {
      drawerEl.classList.remove('hidden');
      renderDrawer(mounted, metrics, activeClaim);
    } else {
      drawerEl.classList.add('hidden');
    }
  }

  function renderTimeline(mounted, duration) {
    const chunksContainer = mounted.querySelector('#yt-truth-timeline-chunks');
    const ticksContainer = mounted.querySelector('#yt-truth-timeline-ticks');
    if (!chunksContainer || !ticksContainer || duration <= 0) return;

    // Render shaded segments for analyzed chunks
    const chunkHtml = [];
    for (const ch of Object.values(STATE.analyzedChunks)) {
      const left = Math.max(0, Math.min(100, (ch.startTime / duration) * 100));
      const width = Math.max(0.5, Math.min(100 - left, ((ch.endTime - ch.startTime) / duration) * 100));
      chunkHtml.push(
        `<div class="yt-truth-timeline-chunk" style="left:${left.toFixed(2)}%;width:${width.toFixed(
          2
        )}%;"></div>`
      );
    }
    setSafeHtml(chunksContainer, chunkHtml.join(''));

    // Render colored ticks for all claims
    const claims = getAllClaims();
    const tickHtml = [];
    for (const c of claims) {
      const left = Math.max(0, Math.min(99.4, (c.startTime / duration) * 100));
      const width = Math.max(
        0.5,
        Math.min(100 - left, ((c.endTime - c.startTime) / duration) * 100)
      );
      const vClass =
        c.verdict === 'TRUE'
          ? 'tick-true'
          : c.verdict === 'FALSE'
          ? 'tick-false'
          : 'tick-questionable';
      const title = `[${formatTime(c.startTime)}] ${c.verdict}: ${c.claimText} — ${c.explanation}`;
      tickHtml.push(
        `<div class="yt-truth-timeline-tick ${vClass}" data-start="${
          c.startTime
        }" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%;" title="${escapeHtml(
          title
        )}"></div>`
      );
    }
    setSafeHtml(ticksContainer, tickHtml.join(''));
  }

  function renderDrawer(mounted, metrics, activeClaim) {
    const summaryEl = mounted.querySelector('#yt-truth-drawer-summary');
    const listEl = mounted.querySelector('#yt-truth-claims-list');
    const filterBtns = mounted.querySelectorAll('.yt-truth-filter-btn');

    filterBtns.forEach((btn) => {
      const f = btn.getAttribute('data-filter');
      btn.classList.toggle('active', f === STATE.activeFilter);
      if (f === 'ALL') btn.textContent = `All (${metrics.totalClaims})`;
      if (f === 'FALSE') btn.textContent = `✗ False (${metrics.falseCount})`;
      if (f === 'QUESTIONABLE') btn.textContent = `⚠ Questionable (${metrics.questionableCount})`;
      if (f === 'TRUE') btn.textContent = `✓ True (${metrics.trueCount})`;
    });

    if (!metrics.isRelevant) {
      setSafeHtml(
        summaryEl,
        `<strong>Not Applicable (N/A):</strong> This video was classified as <strong>${escapeHtml(
          STATE.irrelevantReason || 'Entertainment / Non-factual'
        )}</strong> (0% relevant for fact-checking).`
      );
      setSafeHtml(
        listEl,
        `<div class="yt-truth-empty-state">No factual claims to check in this video.</div>`
      );
      return;
    }

    if (metrics.checkedCount === 0) {
      setSafeHtml(summaryEl, `Analyzing video captions in parallel with playback...`);
      setSafeHtml(
        listEl,
        `<div class="yt-truth-empty-state">Extracting and verifying claims from current playback window...</div>`
      );
      return;
    }

    setSafeHtml(
      summaryEl,
      `<strong>${
        metrics.relevancePct ?? 0
      }% of analyzed content</strong> is relevant for fact-checking. Out of <strong>${
        metrics.totalClaims
      } claims</strong> checked across ${metrics.checkedCount} window${
        metrics.checkedCount === 1 ? '' : 's'
      }, the accuracy score is <strong>${
        metrics.accuracyPct !== null ? `${metrics.accuracyPct}%` : '100%'
      }</strong> (${metrics.trueCount} True, ${metrics.questionableCount} Questionable, ${
        metrics.falseCount
      } False).`
    );

    let claims = getAllClaims();
    if (STATE.activeFilter !== 'ALL') {
      claims = claims.filter((c) => c.verdict === STATE.activeFilter);
    }

    if (claims.length === 0) {
      setSafeHtml(
        listEl,
        `<div class="yt-truth-empty-state">No claims match the "${STATE.activeFilter}" filter yet.</div>`
      );
      return;
    }

    setSafeHtml(
      listEl,
      claims
        .map((c) => {
          const vLower = c.verdict.toLowerCase();
          const isCurrent = activeClaim && activeClaim.id === c.id;
          const badgeLabel =
            c.verdict === 'TRUE'
              ? '✓ TRUE'
              : c.verdict === 'FALSE'
              ? '✗ FALSE'
              : '⚠ QUESTIONABLE';

          const methodLabel = c.verifyingWithSearch
            ? '🔍 Searching Google...'
            : c.searchVerified
            ? '🌐 Google Search Verified'
            : '⚡ Gemini Knowledge';

          const sourcesHtml =
            Array.isArray(c.sources) && c.sources.length > 0
              ? `<div class="yt-truth-card-sources">
                ${c.sources
                  .map(
                    (s) =>
                      `<a class="yt-truth-source-link" href="${escapeHtml(
                        s.url
                      )}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(
                        s.title || s.url
                      )}">🔗 ${escapeHtml(s.title || s.url)}</a>`
                  )
                  .join('')}
              </div>`
              : '';

          return `
          <div class="yt-truth-claim-card card-${vLower} ${
            isCurrent ? 'active-now' : ''
          }" data-claim-id="${escapeHtml(c.id)}">
            <div class="yt-truth-card-top">
              <div class="yt-truth-card-left-meta">
                <button type="button" class="yt-truth-seek-btn" data-start="${
                  c.startTime
                }" title="Jump to ${formatTime(c.startTime)}">
                  ▶ ${formatTime(c.startTime)}
                </button>
                <span class="yt-truth-verdict-badge verdict-${vLower}">${badgeLabel}</span>
              </div>
              <span class="yt-truth-method-tag ${
                c.searchVerified ? 'web-verified' : ''
              }">${methodLabel}</span>
            </div>
            <div class="yt-truth-card-claim">"${escapeHtml(c.claimText)}"</div>
            <div class="yt-truth-card-explanation">${escapeHtml(c.explanation)}</div>
            ${sourcesHtml}
          </div>
        `;
        })
        .join('')
    );
  }

  /**
   * Check if `timeSec` is already covered by an analyzed window
   */
  function findCoveringWindow(timeSec) {
    for (const ch of Object.values(STATE.analyzedChunks)) {
      if (timeSec >= ch.startTime - 2 && timeSec <= ch.endTime + 2) {
        return ch;
      }
    }
    return null;
  }

  /**
   * Build an on-demand 15-minute window starting at `windowStartSec`
   * without overlapping any already-analyzed window ahead of it, and never checking backward.
   */
  function buildOnDemandWindow(windowStartSec) {
    if (!Array.isArray(STATE.segments) || STATE.segments.length === 0) return null;
    const windowDuration = STATE.settings.chunkDurationSec || 900; // 15 minutes default
    let maxEndSec = windowStartSec + windowDuration;

    // Don't overlap if there is already an analyzed window ahead of windowStartSec
    for (const ch of Object.values(STATE.analyzedChunks)) {
      if (ch.startTime > windowStartSec && ch.startTime < maxEndSec) {
        maxEndSec = ch.startTime;
      }
    }

    const windowSegments = STATE.segments.filter(
      (seg) => seg.end > windowStartSec && seg.start < maxEndSec
    );
    if (windowSegments.length === 0) return null;

    const actualStart = Math.max(0, Math.floor(Math.min(windowStartSec, windowSegments[0].start)));
    const actualEnd = Math.ceil(windowSegments[windowSegments.length - 1].end);
    const windowKey = `${actualStart}_${actualEnd}`;

    if (STATE.analyzedChunks[windowKey]) return null;

    return {
      index: windowKey,
      startTime: actualStart,
      endTime: actualEnd,
      segments: windowSegments
    };
  }

  /**
   * Determine if we need to analyze a window right now based on current playback position:
   *  - Case A: Current playback position is not inside any analyzed window -> check 15 mins starting from currentTime!
   *  - Case B: Current playback is within `lookaheadBufferSec` (60s) of the end of the current window -> prefetch next 15 mins!
   *  - Otherwise: Do NOTHING (zero API calls while watching inside an already-checked 15-min window).
   */
  function getNeededWindowAtCurrentTime() {
    if (!STATE.hasCaptions || !STATE.segments.length) return null;
    const currentTime = videoEl ? videoEl.currentTime || 0 : 0;
    const lookahead = STATE.settings.lookaheadBufferSec || 60;

    const covering = findCoveringWindow(currentTime);
    if (!covering) {
      return buildOnDemandWindow(currentTime);
    }

    // Only prefetch the next window if the user has watched up to within 60s of the end of the current window
    const lastVideoSegEnd = STATE.segments[STATE.segments.length - 1].end;
    if (
      covering.endTime < lastVideoSegEnd - 5 &&
      currentTime >= covering.endTime - lookahead &&
      !findCoveringWindow(covering.endTime + 3)
    ) {
      return buildOnDemandWindow(covering.endTime);
    }

    return null;
  }

  /**
   * Wait until the YouTube <video> element has loaded metadata and settled its initial resume timestamp
   * (so starting a video in the middle reads the real middle timestamp, not 0:00).
   */
  async function waitForInitialPlaybackPosition(runToken) {
    // Check if URL has explicit ?t= param first
    try {
      const urlT = new URL(window.location.href).searchParams.get('t');
      if (urlT) {
        const parsedT = parseInt(urlT.replace(/s$/i, ''), 10);
        if (parsedT > 0 && videoEl && videoEl.currentTime < 2) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }
    } catch {
      // ignore
    }

    for (let attempt = 0; attempt < 16; attempt++) {
      if (runToken !== currentRunToken) return;
      bindVideoListeners();
      if (videoEl && videoEl.readyState >= 1) {
        // Give YouTube's player 550ms after metadata is ready to apply saved watch-history resume position
        await new Promise((r) => setTimeout(r, 550));
        return;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  /**
   * Analyzes AT MOST ONE 15-minute window needed for the current playback position, then stops.
   */
  async function maybeAnalyzeCurrentWindow(runToken) {
    if (runToken !== currentRunToken) return;
    if (STATE.isAnalyzing || STATE.isPaused || !STATE.hasCaptions || !STATE.isVideoRelevant) {
      scheduleRender();
      return;
    }

    const neededWindow = getNeededWindowAtCurrentTime();
    if (!neededWindow) {
      scheduleRender();
      return;
    }

    STATE.isAnalyzing = true;
    STATE.activeWindowRange = {
      startTime: neededWindow.startTime,
      endTime: neededWindow.endTime
    };
    scheduleRender();

    const isFirstChunk = Object.keys(STATE.analyzedChunks).length === 0;
    const resp = await chrome.runtime.sendMessage({
      type: 'ANALYZE_CHUNK',
      payload: {
        videoId: STATE.videoId,
        metadata: STATE.metadata,
        chunk: neededWindow,
        isFirstChunk,
        totalChunks: 1,
        languageCode: STATE.languageCode
      }
    });

    if (runToken !== currentRunToken) return;

    STATE.isAnalyzing = false;
    STATE.activeWindowRange = null;

    if (!resp || !resp.ok) {
      if (resp?.code === 'MISSING_API_KEY') {
        STATE.missingApiKey = true;
        STATE.drawerOpen = true;
      } else {
        STATE.error = resp?.error || 'Failed to analyze segment';
      }
      scheduleRender();
      return;
    }

    STATE.missingApiKey = false;
    STATE.error = null;
    if (resp.chunkResult) {
      STATE.analyzedChunks[neededWindow.index] = resp.chunkResult;
    }
    if (resp.videoCache) {
      STATE.isVideoRelevant = resp.videoCache.isVideoRelevant !== false;
      STATE.irrelevantReason = resp.videoCache.irrelevantReason || '';
    }
    scheduleRender();
  }

  async function refreshSettingsAndMaybeRestart() {
    if (!STATE.videoId) return;
    const cfgResp = await chrome.runtime.sendMessage({
      type: 'GET_CONFIG_AND_CACHE',
      videoId: STATE.videoId
    });
    if (cfgResp?.ok && cfgResp.settings) {
      STATE.settings = cfgResp.settings;
      STATE.missingApiKey = !cfgResp.settings.hasApiKey;
      if (!STATE.missingApiKey && STATE.hasCaptions && !STATE.isAnalyzing) {
        maybeAnalyzeCurrentWindow(currentRunToken);
      } else {
        scheduleRender();
      }
    }
  }

  function bindVideoListeners() {
    const v = document.querySelector('video.html5-main-video');
    if (v && v !== videoEl) {
      videoEl = v;
      videoEl.addEventListener('timeupdate', () => {
        scheduleRender();
        if (!STATE.isAnalyzing && !STATE.isPaused && STATE.hasCaptions && STATE.isVideoRelevant) {
          if (getNeededWindowAtCurrentTime()) {
            maybeAnalyzeCurrentWindow(currentRunToken);
          }
        }
      });
      videoEl.addEventListener('seeked', () => {
        scheduleRender();
        if (!STATE.isAnalyzing && !STATE.isPaused && STATE.hasCaptions && STATE.isVideoRelevant) {
          if (getNeededWindowAtCurrentTime()) {
            maybeAnalyzeCurrentWindow(currentRunToken);
          }
        }
      });
    }
  }

  async function initForVideo(videoId) {
    const runToken = ++currentRunToken;
    STATE.videoId = videoId;
    STATE.metadata = null;
    STATE.hasCaptions = false;
    STATE.segments = [];
    STATE.chunks = [];
    STATE.analyzedChunks = {};
    STATE.isVideoRelevant = true;
    STATE.irrelevantReason = '';
    STATE.isAnalyzing = true;
    STATE.error = null;
    STATE.activeClaimId = null;

    ensureRootMounted();
    bindVideoListeners();
    scheduleRender();

    // 1. Load settings & cached chunks from service worker
    const cfgResp = await chrome.runtime.sendMessage({
      type: 'GET_CONFIG_AND_CACHE',
      videoId
    });
    if (runToken !== currentRunToken) return;

    if (cfgResp?.ok) {
      STATE.settings = cfgResp.settings || STATE.settings;
      STATE.missingApiKey = !STATE.settings.hasApiKey;
      STATE.isPaused = !STATE.settings.autoCheck;
      if (cfgResp.cache) {
        STATE.analyzedChunks = cfgResp.cache.chunks || {};
        STATE.isVideoRelevant = cfgResp.cache.isVideoRelevant !== false;
        STATE.irrelevantReason = cfgResp.cache.irrelevantReason || '';
      }
    }

    // 2. Fetch video metadata + Closed Captions (CC) via Service Worker first, with Page Bridge fallback
    let transcriptData = null;
    try {
      const swResp = await chrome.runtime.sendMessage({
        type: 'FETCH_VIDEO_TRANSCRIPT',
        videoId
      });
      if (swResp?.ok && swResp.data?.hasCaptions && swResp.data.segments?.length > 0) {
        transcriptData = swResp.data;
      }
    } catch {
      // fallback to page bridge below
    }

    if (runToken !== currentRunToken) return;

    if (!transcriptData) {
      const bridgeResp = await fetchVideoDataFromBridge(videoId);
      if (runToken !== currentRunToken) return;
      if (bridgeResp?.success && bridgeResp.data) {
        transcriptData = bridgeResp.data;
      } else {
        STATE.hasCaptions = false;
        STATE.isAnalyzing = false;
        STATE.error = bridgeResp?.error || 'Could not read YouTube player data.';
        scheduleRender();
        return;
      }
    }

    const { metadata, hasCaptions, languageCode, segments } = transcriptData;
    STATE.metadata = metadata;
    STATE.languageCode = languageCode || 'en';
    STATE.hasCaptions = Boolean(hasCaptions && segments && segments.length > 0);
    STATE.segments = segments || [];

    if (!STATE.hasCaptions) {
      STATE.isAnalyzing = false;
      scheduleRender();
      return;
    }

    STATE.isAnalyzing = false;
    scheduleRender();

    if (STATE.missingApiKey) {
      scheduleRender();
      return;
    }

    // 3. Wait for YouTube's <video> player to settle its initial resume timestamp (e.g. starting mid-video),
    //    then analyze ONLY the single 15-minute window starting at currentTime!
    await waitForInitialPlaybackPosition(runToken);
    if (runToken !== currentRunToken) return;
    maybeAnalyzeCurrentWindow(runToken);
  }

  function checkCurrentPage() {
    bindVideoListeners();
    ensureRootMounted();
    const vid = getWatchVideoId();
    if (vid && vid !== STATE.videoId) {
      initForVideo(vid);
    } else if (!vid && STATE.videoId) {
      STATE.videoId = null;
      currentRunToken++;
    }
  }

  // Listen for YouTube SPA navigation events and fullscreen/theater transitions
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(checkCurrentPage, 150);
  });

  document.addEventListener('fullscreenchange', () => {
    scheduleRender();
  });

  // Observe DOM for player availability & theater mode switches
  const observer = new MutationObserver(() => {
    checkCurrentPage();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['theater']
  });

  checkCurrentPage();
})();
