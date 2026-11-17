/**
 * YouTube Truth Bar — Page Bridge (Runs in MAIN world)
 *
 * Bridges YouTube's internal player API (`#movie_player`, Innertube `/youtubei/v1/player`)
 * with the isolated content script via CustomEvents.
 *
 * IMPORTANT: Uses pure-JS regex/JSON parsing (zero `innerHTML` or `DOMParser`) so YouTube's
 * strict TrustedTypes Content Security Policy never blocks transcript parsing.
 */
(() => {
  if (window.__ytTruthBridgeInitialized) return;
  window.__ytTruthBridgeInitialized = true;

  /**
   * Pure-JS HTML entity decoder (safe under YouTube's TrustedTypes CSP)
   */
  function decodeHtmlEntities(str) {
    if (!str) return '';
    return String(str)
      .replace(/&#(\d+);/g, (_, dec) => {
        const code = parseInt(dec, 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
        const code = parseInt(hex, 16);
        return Number.isFinite(code) ? String.fromCodePoint(code) : _;
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
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
   * Pure-JS XML timedtext parser (handles both <text start="" dur=""> and <p t="" d=""> formats
   * without DOMParser, avoiding TrustedHTML CSP errors on www.youtube.com)
   */
  function parseXmlTranscript(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    const segments = [];

    // Format 1: <text start="0.67" dur="3.31">...</text>
    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
    let match;
    while ((match = textRegex.exec(xmlText)) !== null) {
      const attrs = match[1];
      const rawContent = match[2].replace(/<[^>]+>/g, '');
      const startMatch = attrs.match(/\bstart\s*=\s*["']([^"']+)["']/i);
      const durMatch = attrs.match(/\bdur\s*=\s*["']([^"']+)["']/i);
      const start = startMatch ? parseFloat(startMatch[1]) : 0;
      const duration = durMatch ? parseFloat(durMatch[1]) : 3;
      const text = decodeHtmlEntities(rawContent).replace(/\s+/g, ' ').trim();
      if (text) {
        segments.push({
          start: Math.round(start * 10) / 10,
          duration: Math.round(duration * 10) / 10,
          end: Math.round((start + duration) * 10) / 10,
          text
        });
      }
    }
    if (segments.length > 0) return segments;

    // Format 2: <p t="1200" d="3400"><s>...</s></p>
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/gi;
    while ((match = pRegex.exec(xmlText)) !== null) {
      const attrs = match[1];
      const rawContent = match[2].replace(/<[^>]+>/g, '');
      const tMatch = attrs.match(/\bt\s*=\s*["']([^"']+)["']/i);
      const dMatch = attrs.match(/\bd\s*=\s*["']([^"']+)["']/i);
      if (!tMatch) continue;
      const start = parseFloat(tMatch[1]) / 1000;
      const duration = dMatch ? parseFloat(dMatch[1]) / 1000 : 3;
      const text = decodeHtmlEntities(rawContent).replace(/\s+/g, ' ').trim();
      if (text) {
        segments.push({
          start: Math.round(start * 10) / 10,
          duration: Math.round(duration * 10) / 10,
          end: Math.round((start + duration) * 10) / 10,
          text
        });
      }
    }

    return segments;
  }

  /**
   * Choose the best caption track using YouTube's defaultAudioTrackIndex / original audio track (.4)
   * so multi-language auto-dubbed videos don't default to alphabetical index 0 ("Arabic").
   */
  function selectBestCaptionTrack(renderer) {
    const tracks = Array.isArray(renderer)
      ? renderer
      : renderer?.captionTracks || [];
    if (tracks.length === 0) return null;
    if (tracks.length === 1) return tracks[0];

    const audioTracks = renderer?.audioTracks || [];
    const defaultIdx =
      typeof renderer?.defaultAudioTrackIndex === 'number'
        ? renderer.defaultAudioTrackIndex
        : -1;
    const origAudio =
      (defaultIdx >= 0 && audioTracks[defaultIdx]) ||
      audioTracks.find((a) => String(a.audioTrackId || '').endsWith('.4')) ||
      audioTracks[0];

    if (
      origAudio &&
      Array.isArray(origAudio.captionTrackIndices) &&
      origAudio.captionTrackIndices.length > 0
    ) {
      const primaryTrackIdx = origAudio.captionTrackIndices[0];
      if (tracks[primaryTrackIdx]) {
        return tracks[primaryTrackIdx];
      }
    }

    const isPreferredLang = (code) => /^(en|iw|he)(-|$)/i.test(String(code || ''));
    const manualTracks = tracks.filter((t) => t.kind !== 'asr');
    if (manualTracks.length > 0) {
      return manualTracks.find((t) => isPreferredLang(t.languageCode)) || manualTracks[0];
    }
    return tracks.find((t) => isPreferredLang(t.languageCode)) || tracks[0];
  }

  /**
   * Fetch playerResponse via YouTube's Innertube /youtubei/v1/player endpoint using
   * IOS or ANDROID client contexts (whose timedtext URLs do not require WEB 'pot' tokens).
   */
  async function fetchInnertubePlayerResponse(videoId) {
    const clients = [
      { clientName: 'IOS', clientVersion: '20.10.4' },
      { clientName: 'ANDROID', clientVersion: '20.10.38' }
    ];

    for (const client of clients) {
      try {
        const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            context: {
              client: {
                clientName: client.clientName,
                clientVersion: client.clientVersion,
                hl: 'en',
                gl: 'US'
              }
            },
            videoId
          })
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const tracks =
          data?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
        if (tracks.length > 0) {
          return data;
        }
      } catch {
        // try next client
      }
    }
    return null;
  }

  async function fetchSegmentsFromTrack(track) {
    if (!track || !track.baseUrl) return [];

    // 1. Try direct baseUrl (returns clean XML on IOS/ANDROID Innertube tracks)
    try {
      const resp = await fetch(track.baseUrl, { credentials: 'omit' });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim().length > 0) {
          if (text.trim().startsWith('<')) {
            const segs = parseXmlTranscript(text);
            if (segs.length > 0) return segs;
          } else if (text.trim().startsWith('{')) {
            const segs = parseJson3Transcript(text);
            if (segs.length > 0) return segs;
          }
        }
      }
    } catch {
      // continue
    }

    // 2. Try fmt=json3
    try {
      const json3Url = track.baseUrl.includes('fmt=')
        ? track.baseUrl.replace(/fmt=[^&]+/, 'fmt=json3')
        : `${track.baseUrl}&fmt=json3`;
      const resp = await fetch(json3Url, { credentials: 'omit' });
      if (resp.ok) {
        const text = await resp.text();
        if (text && text.trim().length > 0) {
          if (text.trim().startsWith('{')) {
            const segs = parseJson3Transcript(text);
            if (segs.length > 0) return segs;
          } else if (text.trim().startsWith('<')) {
            const segs = parseXmlTranscript(text);
            if (segs.length > 0) return segs;
          }
        }
      }
    } catch {
      // continue
    }

    return [];
  }

  /**
   * Retrieve video metadata + timestamped CC transcript for targetVideoId
   */
  async function getVideoDataAndTranscript(targetVideoId) {
    const player =
      document.getElementById('shorts-player') ||
      document.getElementById('movie_player');
    let pagePlayerResponse = null;

    if (player && typeof player.getPlayerResponse === 'function') {
      const pr = player.getPlayerResponse();
      if (pr && pr.videoDetails && pr.videoDetails.videoId === targetVideoId) {
        pagePlayerResponse = pr;
      }
    }
    if (
      !pagePlayerResponse &&
      window.ytInitialPlayerResponse &&
      window.ytInitialPlayerResponse.videoDetails?.videoId === targetVideoId
    ) {
      pagePlayerResponse = window.ytInitialPlayerResponse;
    }

    // Fetch IOS/ANDROID Innertube playerResponse for non-pot-restricted caption tracks
    const innertubePR = await fetchInnertubePlayerResponse(targetVideoId);
    const activePR = innertubePR || pagePlayerResponse || {};

    const details =
      pagePlayerResponse?.videoDetails || innertubePR?.videoDetails || {};
    const microformat =
      pagePlayerResponse?.microformat?.playerMicroformatRenderer ||
      innertubePR?.microformat?.playerMicroformatRenderer ||
      {};

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

    const innertubeRenderer =
      innertubePR?.captions?.playerCaptionsTracklistRenderer;
    const pageRenderer =
      pagePlayerResponse?.captions?.playerCaptionsTracklistRenderer;

    let segments = [];
    let chosenTrack = selectBestCaptionTrack(innertubeRenderer);

    if (chosenTrack) {
      segments = await fetchSegmentsFromTrack(chosenTrack);
    }

    if (segments.length === 0 && pageRenderer?.captionTracks?.length > 0) {
      chosenTrack = selectBestCaptionTrack(pageRenderer);
      segments = await fetchSegmentsFromTrack(chosenTrack);
    }

    const languageCode = chosenTrack?.languageCode || 'en';
    const languageName =
      chosenTrack?.name?.simpleText ||
      chosenTrack?.name?.runs?.map((r) => r.text).join('') ||
      languageCode;
    const isAutoGenerated = chosenTrack?.kind === 'asr';

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
    const isShorts = window.location.pathname.startsWith('/shorts/');
    const player = isShorts
      ? document.getElementById('shorts-player') || document.getElementById('movie_player')
      : document.getElementById('movie_player');
    if (player && typeof player.seekTo === 'function') {
      player.seekTo(seconds, true);
      return;
    }
    const video =
      document.querySelector('#shorts-player video.html5-main-video') ||
      document.querySelector('ytd-reel-video-renderer[is-active] video') ||
      document.querySelector('video.html5-main-video');
    if (video) {
      video.currentTime = seconds;
    }
  });
})();
