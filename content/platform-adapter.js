/**
 * Truth Bar — Multi-Platform Adapter (YouTube, Coursera, edX)
 *
 * Centralizes platform detection, video element discovery, stable video IDs,
 * and DOM mounting targets so the core fact-checking UI and pipeline remain
 * 100% platform-agnostic and reusable.
 */
(() => {
  if (window.__ytTruthPlatformAdapter) return;

  function getPlatform() {
    const host = (window.location.hostname || '').toLowerCase();
    if (host.endsWith('youtube.com')) return 'youtube';
    if (host.endsWith('coursera.org')) return 'coursera';
    if (host.endsWith('edx.org')) return 'edx';
    return 'generic';
  }

  function isShortsPage() {
    try {
      return getPlatform() === 'youtube' && window.location.pathname.startsWith('/shorts/');
    } catch {
      return false;
    }
  }

  function isEmbedPage() {
    try {
      return getPlatform() === 'youtube' && window.location.pathname.startsWith('/embed/');
    } catch {
      return false;
    }
  }

  /**
   * Short deterministic string hash for stable non-YouTube video IDs
   */
  function simpleHash(str) {
    let h = 2166136261;
    const s = String(str || '');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * Discover the primary active HTML5 <video> element on the page
   */
  function findActiveVideoElement() {
    const platform = getPlatform();
    if (platform === 'youtube') {
      if (isShortsPage()) {
        return (
          document.querySelector('#shorts-player video.html5-main-video') ||
          document.querySelector('ytd-reel-video-renderer[is-active] video') ||
          document.querySelector('video.html5-main-video')
        );
      }
      return (
        document.querySelector('#movie_player video.html5-main-video') ||
        document.querySelector('video.html5-main-video') ||
        document.querySelector('video')
      );
    }

    if (platform === 'coursera') {
      return (
        document.querySelector('.rc-VideoPlayer video') ||
        document.querySelector('[data-testid="video-player"] video') ||
        document.querySelector('video.vjs-tech') ||
        document.querySelector('video')
      );
    }

    if (platform === 'edx') {
      return (
        document.querySelector('.video video') ||
        document.querySelector('.tc-wrapper video') ||
        document.querySelector('.video-player video') ||
        document.querySelector('video.vjs-tech') ||
        document.querySelector('video')
      );
    }

    return document.querySelector('video');
  }

  /**
   * Inspect edX `div.video[data-metadata]` if present on the page.
   * Returns parsed metadata object or null.
   */
  function getEdxVideoMetadata() {
    const el = document.querySelector('.video[data-metadata], [data-metadata*="transcript"]');
    if (!el) return null;
    const raw = el.getAttribute('data-metadata');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /**
   * Extract an embedded YouTube 11-char videoId from edX `data-metadata.streams` if present
   * (e.g. "0.75:abc12345678,1.00:abc12345678,1.25:abc12345678")
   */
  function extractEdxYoutubeId(edxMeta) {
    if (!edxMeta || !edxMeta.streams) return null;
    const streams = String(edxMeta.streams);
    const match = streams.match(/(?:1\.00|1\.0|0\.75|1\.25|1\.50):([a-zA-Z0-9_-]{11})/);
    return match ? match[1] : null;
  }

  /**
   * Returns the active video identifier for the current page/frame, or null if this
   * page/frame does not currently host an active video player.
   */
  function getWatchVideoId() {
    try {
      const platform = getPlatform();
      const url = new URL(window.location.href);

      if (platform === 'youtube') {
        if (url.pathname === '/watch') {
          return url.searchParams.get('v');
        }
        if (url.pathname.startsWith('/shorts/')) {
          const match = url.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{8,15})/);
          return match ? match[1] : null;
        }
        return null;
      }

      if (platform === 'coursera') {
        const video = findActiveVideoElement();
        if (!video) return null;

        // Extract Coursera lecture ID from URL if available: /learn/<course>/lecture/<itemId>/<slug>
        const lectureMatch = url.pathname.match(/\/lecture\/([^/]+)/);
        if (lectureMatch && lectureMatch[1]) {
          return `coursera_${lectureMatch[1]}`;
        }
        const trackEl = video.querySelector('track[src]');
        const sig =
          (trackEl && trackEl.getAttribute('src')) ||
          video.currentSrc ||
          video.getAttribute('src') ||
          url.pathname;
        return `coursera_${simpleHash(sig)}`;
      }

      if (platform === 'edx') {
        const edxMeta = getEdxVideoMetadata();
        const video = findActiveVideoElement();

        // In edX's multi-frame MFE (learning.edx.org -> courses.edx.org iframe -> optional youtube embed iframe):
        // Avoid mounting a duplicate bar in an outer frame that only embeds a YouTube iframe if there is no native <video> or transcript URL in this frame.
        if (!video && !edxMeta) {
          return null;
        }

        const embeddedYtId = extractEdxYoutubeId(edxMeta);
        // If edX is using an embedded YouTube iframe and there is no native HTML5 <video> in this frame,
        // still allow this frame to run if edxMeta provides transcript data or embeddedYtId (unless the youtube embed handles it).
        if (embeddedYtId) {
          return embeddedYtId;
        }

        if (edxMeta) {
          const blockMatch =
            url.pathname.match(/block-v1:[^\s/]+/) ||
            document
              .querySelector('[data-usage-id]')
              ?.getAttribute('data-usage-id')
              ?.match(/block-v1:[^\s/]+/);
          if (blockMatch) {
            return `edx_${simpleHash(blockMatch[0])}`;
          }
          const sig =
            edxMeta.transcriptTranslationUrl ||
            edxMeta.saveStateUrl ||
            (Array.isArray(edxMeta.sources) && edxMeta.sources[0]) ||
            url.pathname;
          return `edx_${simpleHash(sig)}`;
        }

        if (video) {
          const sig = video.currentSrc || video.getAttribute('src') || url.pathname;
          return `edx_${simpleHash(sig)}`;
        }
        return null;
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Mounts `rootEl` above the video player on YouTube, Coursera, or edX.
   */
  function mountRootAbovePlayer(rootEl) {
    const platform = getPlatform();

    // 1. Fullscreen always takes priority on every platform
    const fsEl = document.fullscreenElement;
    if (fsEl) {
      rootEl.classList.remove('yt-truth-shorts');
      rootEl.classList.add('yt-truth-fullscreen');
      if (rootEl.parentNode !== fsEl) {
        fsEl.prepend(rootEl);
      }
      return rootEl;
    }

    rootEl.classList.remove('yt-truth-fullscreen');

    // 2. Coursera & edX
    if (platform === 'coursera' || platform === 'edx') {
      rootEl.classList.remove('yt-truth-shorts');
      const selectors =
        platform === 'coursera'
          ? [
              '.rc-VideoPlayer',
              '[data-testid="video-player"]',
              '.video-main-player-container',
              '.c-video-player',
              '.video-js'
            ]
          : [
              '.video[data-metadata]',
              '.tc-wrapper',
              '.video-wrapper',
              '.video-player',
              '.xblock-student_view-video'
            ];

      const containers = selectors
        .map((sel) => document.querySelector(sel))
        .filter(Boolean);
      const visibleContainer = containers.find(
        (el) => el.getBoundingClientRect().height > 100 && el.getBoundingClientRect().width > 150
      );

      if (visibleContainer && visibleContainer.parentNode) {
        if (rootEl.nextSibling !== visibleContainer) {
          visibleContainer.parentNode.insertBefore(rootEl, visibleContainer);
        }
        if (rootEl.getBoundingClientRect().height >= 20) {
          return rootEl;
        }
      }

      const video = findActiveVideoElement();
      if (video && video.getBoundingClientRect().height > 100) {
        const host = video.closest('div') || video.parentElement;
        if (host && host.parentNode) {
          if (rootEl.nextSibling !== host) {
            host.parentNode.insertBefore(rootEl, host);
          }
          if (rootEl.getBoundingClientRect().height >= 20) {
            return rootEl;
          }
        }
      }

      if (document.body) {
        rootEl.classList.add('yt-truth-shorts');
        if (rootEl.parentNode !== document.body) {
          document.body.prepend(rootEl);
        }
        return rootEl;
      }
      return null;
    }

    // 3. YouTube Shorts (/shorts/<id>) or YouTube Embed (/embed/<id>)
    if (isShortsPage() || isEmbedPage()) {
      rootEl.classList.add('yt-truth-shorts');
      const shortsHost =
        document.querySelector('ytd-shorts') ||
        document.getElementById('page-manager') ||
        document.body;
      if (shortsHost && rootEl.parentNode !== shortsHost) {
        shortsHost.prepend(rootEl);
      }
      return rootEl;
    }

    rootEl.classList.remove('yt-truth-shorts');

    // 4. YouTube /watch (Theater, Full-Bleed, and Default modes)
    const fullBleed =
      document.getElementById('full-bleed-container') ||
      document.getElementById('player-full-bleed-container') ||
      document.getElementById('player-theater-container');

    // Whenever #full-bleed-container is actively hosting the player, its rendered height is > 100px
    // (when inactive in standard mode, its height is 0px).
    if (
      fullBleed &&
      fullBleed.parentNode &&
      fullBleed.getBoundingClientRect().height > 100
    ) {
      if (rootEl.nextSibling !== fullBleed) {
        fullBleed.parentNode.insertBefore(rootEl, fullBleed);
      }
      if (rootEl.getBoundingClientRect().height >= 20) {
        return rootEl;
      }
    }

    const candidateEls = [
      document.querySelector('#primary-inner > #player'),
      document.getElementById('player-container-outer'),
      document.getElementById('player'),
      document.querySelector('ytd-player#ytd-player')
    ].filter(Boolean);

    // IMPORTANT: Only pick a container that is actually visible (> 100px tall). Never fall back to a 0px-height candidateEls[0].
    const visiblePlayerEl = candidateEls.find(
      (el) => el.getBoundingClientRect().height > 100 && el.getBoundingClientRect().width > 150
    );

    if (visiblePlayerEl && visiblePlayerEl.parentNode) {
      if (rootEl.nextSibling !== visiblePlayerEl) {
        visiblePlayerEl.parentNode.insertBefore(rootEl, visiblePlayerEl);
      }
      if (rootEl.getBoundingClientRect().height >= 20) {
        return rootEl;
      }
    }

    // Guaranteed visible fallback: dock fixed at the top of the viewport whenever inline containers are not yet laid out or hidden
    if (document.body) {
      rootEl.classList.add('yt-truth-shorts');
      if (rootEl.parentNode !== document.body) {
        document.body.prepend(rootEl);
      }
      return rootEl;
    }

    return null;
  }

  /**
   * Read current playback timestamp (seconds) across native HTML5 <video> and edX YT-embed wrappers
   */
  function getCurrentPlaybackTime(videoEl) {
    if (videoEl && typeof videoEl.currentTime === 'number' && !Number.isNaN(videoEl.currentTime)) {
      return videoEl.currentTime;
    }
    if (getPlatform() === 'edx') {
      // Fallback for edX YouTube-embed mode where time is displayed in .vidtime ("1:23 / 10:00")
      // or highlighted in .subtitles-menu li.current [data-start]
      const activeSub = document.querySelector(
        '.subtitles-menu li.current span[data-start], .subtitles li.focused [data-start]'
      );
      if (activeSub) {
        const ms = parseFloat(activeSub.getAttribute('data-start') || '0');
        if (Number.isFinite(ms) && ms >= 0) {
          return ms > 1000 ? ms / 1000 : ms;
        }
      }
      const vidTimeEl = document.querySelector('.vidtime');
      if (vidTimeEl && vidTimeEl.textContent) {
        const currentPart = vidTimeEl.textContent.split('/')[0].trim();
        const parts = currentPart.split(':').map((n) => parseInt(n.trim(), 10));
        if (parts.every((n) => Number.isFinite(n))) {
          if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
          if (parts.length === 2) return parts[0] * 60 + parts[1];
        }
      }
    }
    return 0;
  }

  window.__ytTruthPlatformAdapter = {
    getPlatform,
    isShortsPage,
    isEmbedPage,
    findActiveVideoElement,
    getEdxVideoMetadata,
    extractEdxYoutubeId,
    getWatchVideoId,
    mountRootAbovePlayer,
    getCurrentPlaybackTime
  };
})();
