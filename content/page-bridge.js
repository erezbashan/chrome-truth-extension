/**
 * YouTube Truth Bar — Page Bridge (Runs in MAIN world)
 *
 * Bridges YouTube's internal player API (`#movie_player`, `ytInitialPlayerResponse`,
 * `ytInitialData`, `ytcfg`) with the isolated content script via CustomEvents.
 */
(() => {
  if (window.__ytTruthBridgeInitialized) return;
  window.__ytTruthBridgeInitialized = true;

  function decodeHtmlEntities(str) {
    if (!str) return '';
    const txt = document.createElement('textarea');
    txt.innerHTML = str;
    return txt.value;
  }

  /**
   * Parse JSON3 timedtext format: { events: [{ tStartMs, dDurationMs, segs: [{ utf8 }] }] }
   */
  function parseJson3Transcript(jsonText) {
    try {
      const data = JSON.parse(jsonText);
      if (!data || !Array.isArray(data.events)) return [];
      const segments = [];
      for (const ev of data.events) {
        if (!ev.segs || typeof ev.tStartMs !== 'number') continue;
        const text = ev.segs
          .map((s) => s.utf8 || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (!text || text === '\n') continue;
        const start = ev.tStartMs / 1000;
        const duration = typeof ev.dDurationMs === 'number' ? ev.dDurationMs / 1000 : 3;
        segments.push({
          start: Math.round(start * 10) / 10,
          duration: Math.round(duration * 10) / 10,
          end: Math.round((start + duration) * 10) / 10,
          text: decodeHtmlEntities(text)
        });
      }
      return segments;
    } catch {
      return [];
    }
  }

  /**
   * Parse XML timedtext format (<text start="1.2" dur="3.4">...</text> or <p t="1200" d="3400">...)
   */
  function parseXmlTranscript(xmlText) {
    try {
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'text/xml');
      const segments = [];

      const textNodes = doc.querySelectorAll('text');
      if (textNodes.length > 0) {
        textNodes.forEach((node) => {
          const start = parseFloat(node.getAttribute('start') || '0');
          const duration = parseFloat(node.getAttribute('dur') || '3');
          const text = decodeHtmlEntities(node.textContent || '')
            .replace(/\s+/g, ' ')
            .trim();
          if (text) {
            segments.push({
              start: Math.round(start * 10) / 10,
              duration: Math.round(duration * 10) / 10,
              end: Math.round((start + duration) * 10) / 10,
              text
            });
          }
        });
        return segments;
      }

      const pNodes = doc.querySelectorAll('p');
      pNodes.forEach((node) => {
        const tMs = parseFloat(node.getAttribute('t') || '0');
        const dMs = parseFloat(node.getAttribute('d') || '3000');
        const text = decodeHtmlEntities(node.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          const start = tMs / 1000;
          const duration = dMs / 1000;
          segments.push({
            start: Math.round(start * 10) / 10,
            duration: Math.round(duration * 10) / 10,
            end: Math.round((start + duration) * 10) / 10,
            text
          });
        }
      });
      return segments;
    } catch {
      return [];
    }
  }

  /**
   * Choose the best caption track:
   * Prefer manual captions over auto-generated (ASR), and prefer original audio language or English/Hebrew.
   */
  function selectBestCaptionTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
    const manualTracks = tracks.filter((t) => t.kind !== 'asr');
    if (manualTracks.length > 0) {
      return manualTracks[0];
    }
    return tracks[0];
  }

  /**
   * Extract transcript params from ytInitialData object for /youtubei/v1/get_transcript fallback
   */
  function findTranscriptParams(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.getTranscriptEndpoint && typeof obj.getTranscriptEndpoint.params === 'string') {
      return obj.getTranscriptEndpoint.params;
    }
    for (const key of Object.keys(obj)) {
      const val = obj[key];
      if (val && typeof val === 'object') {
        const found = findTranscriptParams(val);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Parse Innertube /youtubei/v1/get_transcript response
   */
  function parseInnertubeTranscriptResponse(data) {
    const segments = [];
    function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (node.transcriptSegmentRenderer) {
        const renderer = node.transcriptSegmentRenderer;
        const startMs = parseFloat(renderer.startMs || '0');
        const endMs = parseFloat(renderer.endMs || String(startMs + 3000));
        const runs = renderer.snippet?.runs || [];
        const text = runs
          .map((r) => r.text || '')
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (text) {
          const start = startMs / 1000;
          const end = endMs / 1000;
          segments.push({
            start: Math.round(start * 10) / 10,
            duration: Math.round(Math.max(1, end - start) * 10) / 10,
            end: Math.round(end * 10) / 10,
            text
          });
        }
        return;
      }
      for (const k of Object.keys(node)) {
        if (node[k] && typeof node[k] === 'object') {
          walk(node[k]);
        }
      }
    }
    walk(data);
    return segments;
  }

  /**
   * Fetch fresh playerResponse and ytInitialData for a given videoId if SPA state is stale
   */
  async function fetchFreshWatchPageData(videoId) {
    try {
      const resp = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
        credentials: 'same-origin'
      });
      const html = await resp.text();

      let playerResponse = null;
      let initialData = null;

      const prMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*(?:var\s|window\.|<\/script>)/s);
      if (prMatch) {
        try {
          playerResponse = JSON.parse(prMatch[1]);
        } catch {
          // ignore
        }
      }

      const idMatch = html.match(/ytInitialData\s*=\s*(\{.+?\});\s*(?:var\s|window\.|<\/script>)/s);
      if (idMatch) {
        try {
          initialData = JSON.parse(idMatch[1]);
        } catch {
          // ignore
        }
      }

      return { playerResponse, initialData };
    } catch {
      return { playerResponse: null, initialData: null };
    }
  }

  /**
   * Retrieve video metadata + timestamped CC transcript for targetVideoId
   */
  async function getVideoDataAndTranscript(targetVideoId) {
    const player = document.getElementById('movie_player');
    let playerResponse = null;

    // 1. Try live #movie_player API first
    if (player && typeof player.getPlayerResponse === 'function') {
      const pr = player.getPlayerResponse();
      if (pr && pr.videoDetails && pr.videoDetails.videoId === targetVideoId) {
        playerResponse = pr;
      }
    }

    // 2. Try window.ytInitialPlayerResponse
    if (
      !playerResponse &&
      window.ytInitialPlayerResponse &&
      window.ytInitialPlayerResponse.videoDetails?.videoId === targetVideoId
    ) {
      playerResponse = window.ytInitialPlayerResponse;
    }

    let initialData = window.ytInitialData || null;

    // 3. If SPA navigation hasn't updated playerResponse yet or captionTracks are missing, fetch watch page
    if (
      !playerResponse ||
      !playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks
    ) {
      const fresh = await fetchFreshWatchPageData(targetVideoId);
      if (fresh.playerResponse?.videoDetails?.videoId === targetVideoId) {
        playerResponse = fresh.playerResponse;
      }
      if (fresh.initialData) {
        initialData = fresh.initialData;
      }
    }

    const details = playerResponse?.videoDetails || {};
    const microformat = playerResponse?.microformat?.playerMicroformatRenderer || {};

    const metadata = {
      videoId: targetVideoId,
      title: details.title || document.title.replace(/ - YouTube$/, ''),
      author: details.author || '',
      shortDescription: (details.shortDescription || '').slice(0, 1200),
      lengthSeconds: parseInt(details.lengthSeconds || '0', 10) || 0,
      category: microformat.category || '',
      isLiveContent: Boolean(details.isLiveContent),
      keywords: Array.isArray(details.keywords) ? details.keywords.slice(0, 15) : []
    };

    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const chosenTrack = selectBestCaptionTrack(tracks);

    let segments = [];
    let languageCode = chosenTrack?.languageCode || 'en';
    let languageName =
      chosenTrack?.name?.simpleText ||
      chosenTrack?.name?.runs?.map((r) => r.text).join('') ||
      languageCode;
    let isAutoGenerated = chosenTrack?.kind === 'asr';

    // Method A: Fetch timedtext baseUrl (JSON3 then XML)
    if (chosenTrack && chosenTrack.baseUrl) {
      try {
        const json3Url = chosenTrack.baseUrl.includes('fmt=')
          ? chosenTrack.baseUrl.replace(/fmt=[^&]+/, 'fmt=json3')
          : `${chosenTrack.baseUrl}&fmt=json3`;
        const resp = await fetch(json3Url, { credentials: 'same-origin' });
        if (resp.ok) {
          const text = await resp.text();
          if (text && text.trim().startsWith('{')) {
            segments = parseJson3Transcript(text);
          } else if (text && text.trim().startsWith('<')) {
            segments = parseXmlTranscript(text);
          }
        }
      } catch {
        // fallback below
      }

      if (segments.length === 0) {
        try {
          const resp = await fetch(chosenTrack.baseUrl, { credentials: 'same-origin' });
          if (resp.ok) {
            const text = await resp.text();
            if (text && text.trim().startsWith('<')) {
              segments = parseXmlTranscript(text);
            } else if (text && text.trim().startsWith('{')) {
              segments = parseJson3Transcript(text);
            }
          }
        } catch {
          // fallback below
        }
      }
    }

    // Method B: Fallback to YouTube Innertube /youtubei/v1/get_transcript endpoint
    if (segments.length === 0) {
      try {
        let params = findTranscriptParams(initialData);
        if (!params) {
          const fresh = await fetchFreshWatchPageData(targetVideoId);
          if (fresh.initialData) {
            params = findTranscriptParams(fresh.initialData);
          }
        }
        const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY');
        const context = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
        if (params && apiKey && context) {
          const resp = await fetch(
            `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ context, params })
            }
          );
          if (resp.ok) {
            const data = await resp.json();
            segments = parseInnertubeTranscriptResponse(data);
          }
        }
      } catch {
        // ignore
      }
    }

    return {
      metadata,
      hasCaptions: segments.length > 0,
      languageCode,
      languageName,
      isAutoGenerated,
      segments
    };
  }

  // Listen for requests from isolated content script
  window.addEventListener('YT_TRUTH_FETCH_VIDEO_DATA', async (event) => {
    const detail = event.detail || {};
    const videoId = detail.videoId;
    const requestId = detail.requestId;
    if (!videoId) return;

    try {
      const result = await getVideoDataAndTranscript(videoId);
      window.dispatchEvent(
        new CustomEvent('YT_TRUTH_VIDEO_DATA_RESULT', {
          detail: { requestId, videoId, success: true, data: result }
        })
      );
    } catch (err) {
      window.dispatchEvent(
        new CustomEvent('YT_TRUTH_VIDEO_DATA_RESULT', {
          detail: {
            requestId,
            videoId,
            success: false,
            error: err?.message || 'Failed to extract captions'
          }
        })
      );
    }
  });

  // Listen for seek requests from isolated content script
  window.addEventListener('YT_TRUTH_SEEK_TO', (event) => {
    const seconds = Number(event.detail?.seconds);
    if (Number.isNaN(seconds)) return;
    const player = document.getElementById('movie_player');
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(seconds, true);
      return;
    }
    const video = document.querySelector('video.html5-main-video');
    if (video) {
      video.currentTime = seconds;
    }
  });
})();
