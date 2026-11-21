/**
 * Truth Bar — Page Bridge (Runs in MAIN world on YouTube, Coursera, and edX)
 *
 * Bridges platform video players and caption/transcript sources with the
 * isolated content script via CustomEvents:
 *  - YouTube: `#movie_player`, `#shorts-player`, Innertube `/youtubei/v1/player`
 *  - Coursera: Video.js `<video>`, `<track src="*.vtt">`, `video.textTracks`, `.rc-Transcript`
 *  - edX: `div.video[data-metadata]` (`transcriptTranslationUrl`, embedded YouTube streams, `<track>`, `.subtitles-menu`)
 *
 * IMPORTANT: Uses pure-JS regex/JSON parsing (zero `innerHTML` or `DOMParser`) so strict
 * TrustedTypes Content Security Policies never block transcript parsing.
 */
(() => {
  if (window.__ytTruthBridgeInitialized) return;
  window.__ytTruthBridgeInitialized = true;

  function getPlatform() {
    const host = (window.location.hostname || '').toLowerCase();
    if (host.endsWith('youtube.com')) return 'youtube';
    if (host.endsWith('coursera.org')) return 'coursera';
    if (host.endsWith('edx.org')) return 'edx';
    return 'generic';
  }

  /**
   * Pure-JS HTML entity decoder (safe under TrustedTypes CSP)
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
   * Parse HH:MM:SS.mmm or MM:SS.mmm or HH:MM:SS,mmm timestamp string into seconds
   */
  function parseTimestampToSeconds(ts) {
    if (!ts) return NaN;
    const clean = String(ts).trim().replace(',', '.');
    const parts = clean.split(':');
    if (parts.length === 3) {
      return (
        parseInt(parts[0], 10) * 3600 +
        parseInt(parts[1], 10) * 60 +
        parseFloat(parts[2])
      );
    }
    if (parts.length === 2) {
      return parseInt(parts[0], 10) * 60 + parseFloat(parts[1]);
    }
    return parseFloat(clean);
  }

  /**
   * Universal WebVTT (.vtt) and SubRip (.srt) transcript parser (used by Coursera, edX, and HTML5 <track>)
   */
  function parseVttOrSrtTranscript(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    const lines = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const segments = [];
    const arrowRegex =
      /((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      const match = line.match(arrowRegex);
      if (!match) {
        i++;
        continue;
      }

      const start = parseTimestampToSeconds(match[1]);
      const end = parseTimestampToSeconds(match[2]);
      i++;

      const textLines = [];
      while (i < lines.length && lines[i].trim() !== '' && !arrowRegex.test(lines[i])) {
        textLines.push(lines[i].trim());
        i++;
      }

      const cleanedText = decodeHtmlEntities(
        textLines
          .join(' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
      );

      if (cleanedText && Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        const dur = Math.max(0.5, end - start);
        segments.push({
          start: Math.round(start * 10) / 10,
          duration: Math.round(dur * 10) / 10,
          end: Math.round(end * 10) / 10,
          text: cleanedText
        });
      }
    }

    return segments;
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
   * Parse edX transcript JSON format: { start: [ms, ...], end: [ms, ...], text: [str, ...] }
   */
  function parseEdxJsonTranscript(jsonData) {
    try {
      const data = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
      if (!data || !Array.isArray(data.start) || !Array.isArray(data.text)) return [];
      const segments = [];
      for (let i = 0; i < data.text.length; i++) {
        const rawText = decodeHtmlEntities(String(data.text[i] || ''))
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!rawText) continue;
        const startMs = Number(data.start[i] ?? 0);
        const endMs = Number(data.end?.[i] ?? startMs + 3000);
        const start = Math.max(0, startMs / 1000);
        const end = Math.max(start + 0.5, endMs / 1000);
        segments.push({
          start: Math.round(start * 10) / 10,
          duration: Math.round((end - start) * 10) / 10,
          end: Math.round(end * 10) / 10,
          text: rawText
        });
      }
      return segments;
    } catch {
      return [];
    }
  }

  /**
   * Pure-JS XML timedtext parser (handles both <text start="" dur=""> and <p t="" d=""> formats)
   */
  function parseXmlTranscript(xmlText) {
    if (!xmlText || typeof xmlText !== 'string') return [];
    const segments = [];

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
   * Parse any raw transcript payload (WebVTT, SRT, XML, JSON3, edX JSON)
   */
  function parseAnyTranscriptText(rawText) {
    if (!rawText || typeof rawText !== 'string') return [];
    const trimmed = rawText.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('{')) {
      const edxSegs = parseEdxJsonTranscript(trimmed);
      if (edxSegs.length > 0) return edxSegs;
      const json3Segs = parseJson3Transcript(trimmed);
      if (json3Segs.length > 0) return json3Segs;
    }
    if (trimmed.includes('-->')) {
      const vttSegs = parseVttOrSrtTranscript(trimmed);
      if (vttSegs.length > 0) return vttSegs;
    }
    if (trimmed.startsWith('<')) {
      const xmlSegs = parseXmlTranscript(trimmed);
      if (xmlSegs.length > 0) return xmlSegs;
    }
    return [];
  }

  /**
   * Choose the best caption track using YouTube's defaultAudioTrackIndex / original audio track (.4)
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

    try {
      const resp = await fetch(track.baseUrl, { credentials: 'omit' });
      if (resp.ok) {
        const text = await resp.text();
        const segs = parseAnyTranscriptText(text);
        if (segs.length > 0) return segs;
      }
    } catch {
      // continue
    }

    try {
      const json3Url = track.baseUrl.includes('fmt=')
        ? track.baseUrl.replace(/fmt=[^&]+/, 'fmt=json3')
        : `${track.baseUrl}&fmt=json3`;
      const resp = await fetch(json3Url, { credentials: 'omit' });
      if (resp.ok) {
        const text = await resp.text();
        const segs = parseAnyTranscriptText(text);
        if (segs.length > 0) return segs;
      }
    } catch {
      // continue
    }

    return [];
  }

  /**
   * Extract captions from an HTML5 <video> element via <track src="..."> or video.textTracks cues.
   * Used on Coursera, edX, and generic HTML5 video players.
   */
  async function extractHtml5VideoTranscript(video) {
    if (!video) return null;
    const isPref = (lang) => /^(en|iw|he)(-|$)/i.test(String(lang || ''));

    // 1. Check <track> DOM elements with `src` URLs (WebVTT / SRT)
    const trackEls = Array.from(video.querySelectorAll('track[src]')).filter((t) => {
      const kind = (t.getAttribute('kind') || 'subtitles').toLowerCase();
      return kind === 'captions' || kind === 'subtitles' || kind === '';
    });

    trackEls.sort((a, b) => {
      const aDefault = a.hasAttribute('default') || a.track?.mode === 'showing' ? 1 : 0;
      const bDefault = b.hasAttribute('default') || b.track?.mode === 'showing' ? 1 : 0;
      if (aDefault !== bDefault) return bDefault - aDefault;
      const aPref = isPref(a.getAttribute('srclang')) ? 1 : 0;
      const bPref = isPref(b.getAttribute('srclang')) ? 1 : 0;
      return bPref - aPref;
    });

    for (const trackEl of trackEls) {
      const rawSrc = trackEl.getAttribute('src');
      if (!rawSrc) continue;
      try {
        const absUrl = new URL(rawSrc, window.location.href).href;
        const resp = await fetch(absUrl, { credentials: 'omit' });
        if (resp.ok) {
          const text = await resp.text();
          const segments = parseAnyTranscriptText(text);
          if (segments.length > 0) {
            return {
              languageCode: trackEl.getAttribute('srclang') || 'en',
              languageName: trackEl.getAttribute('label') || trackEl.getAttribute('srclang') || 'en',
              segments
            };
          }
        }
      } catch {
        // Fallback to textTracks below if CORS blocks direct fetch
      }
    }

    // 2. Inspect video.textTracks (browser-loaded VTTCue list)
    if (video.textTracks && video.textTracks.length > 0) {
      const textTracks = Array.from(video.textTracks).filter(
        (t) => t.kind === 'captions' || t.kind === 'subtitles' || !t.kind
      );
      if (textTracks.length > 0) {
        textTracks.sort((a, b) => {
          const aShow = a.mode === 'showing' ? 2 : a.mode === 'hidden' ? 1 : 0;
          const bShow = b.mode === 'showing' ? 2 : b.mode === 'hidden' ? 1 : 0;
          if (aShow !== bShow) return bShow - aShow;
          const aPref = isPref(a.language) ? 1 : 0;
          const bPref = isPref(b.language) ? 1 : 0;
          return bPref - aPref;
        });

        const chosen = textTracks[0];
        if (chosen.mode === 'disabled') {
          chosen.mode = 'hidden';
        }

        // Wait up to 1.6s for Chrome to load the TextTrack cues
        for (let attempt = 0; attempt < 8; attempt++) {
          if (chosen.cues && chosen.cues.length > 0) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        if (chosen.cues && chosen.cues.length > 0) {
          const segments = [];
          for (let i = 0; i < chosen.cues.length; i++) {
            const cue = chosen.cues[i];
            const text = decodeHtmlEntities(String(cue.text || ''))
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim();
            if (!text) continue;
            const start = Number(cue.startTime || 0);
            const end = Number(cue.endTime || start + 3);
            segments.push({
              start: Math.round(start * 10) / 10,
              duration: Math.round(Math.max(0.5, end - start) * 10) / 10,
              end: Math.round(end * 10) / 10,
              text
            });
          }
          if (segments.length > 0) {
            return {
              languageCode: chosen.language || 'en',
              languageName: chosen.label || chosen.language || 'en',
              segments
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract transcript from Coursera interactive transcript DOM (.rc-Transcript / .rc-Phrase) if present
   */
  function extractCourseraDomTranscript() {
    const phraseEls = Array.from(
      document.querySelectorAll('.rc-Phrase, [data-cue], [data-phrase-index]')
    );
    if (phraseEls.length === 0) return null;

    const segments = [];
    for (let i = 0; i < phraseEls.length; i++) {
      const el = phraseEls[i];
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const startAttr =
        el.getAttribute('data-start') ||
        el.getAttribute('data-timestamp') ||
        el.getAttribute('data-time');
      let start = startAttr ? parseFloat(startAttr) : NaN;
      if (start > 10000) start = start / 1000;
      if (!Number.isFinite(start)) {
        start = i * 4;
      }
      segments.push({
        start: Math.round(start * 10) / 10,
        duration: 4,
        end: Math.round((start + 4) * 10) / 10,
        text
      });
    }
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i + 1].start > segments[i].start) {
        segments[i].end = segments[i + 1].start;
        segments[i].duration =
          Math.round(Math.max(0.5, segments[i].end - segments[i].start) * 10) / 10;
      }
    }
    return segments.length > 0 ? { languageCode: 'en', languageName: 'en', segments } : null;
  }

  /**
   * Extract transcript on edX from `div.video[data-metadata]` or `.subtitles-menu` DOM
   */
  async function extractEdxTranscript() {
    const videoContainer = document.querySelector(
      '.video[data-metadata], [data-metadata*="transcript"]'
    );
    if (videoContainer) {
      try {
        const meta = JSON.parse(videoContainer.getAttribute('data-metadata') || '{}');
        const lang =
          meta.transcriptLanguage ||
          (meta.transcriptLanguages && Object.keys(meta.transcriptLanguages)[0]) ||
          'en';

        // 1. Try edX transcriptTranslationUrl endpoint
        if (meta.transcriptTranslationUrl) {
          const rawUrl = String(meta.transcriptTranslationUrl).replace('__lang__', lang);
          const absUrl = new URL(rawUrl, window.location.href).href;
          const resp = await fetch(absUrl, { credentials: 'include' });
          if (resp.ok) {
            const text = await resp.text();
            const segments = parseAnyTranscriptText(text);
            if (segments.length > 0) {
              return {
                languageCode: lang,
                languageName: meta.transcriptLanguages?.[lang] || lang,
                segments
              };
            }
          }
        }

        // 2. If edX embeds a YouTube video in `meta.streams` ("1.00:VIDEO_ID"), fetch via Innertube
        if (meta.streams) {
          const ytMatch = String(meta.streams).match(
            /(?:1\.00|1\.0|0\.75|1\.25|1\.50):([a-zA-Z0-9_-]{11})/
          );
          if (ytMatch && ytMatch[1]) {
            const ytRes = await getYouTubeVideoDataAndTranscript(ytMatch[1]);
            if (ytRes && ytRes.hasCaptions && ytRes.segments.length > 0) {
              return ytRes;
            }
          }
        }
      } catch {
        // continue to DOM fallback
      }
    }

    // 3. Fallback: edX DOM subtitles list (.subtitles-menu li span[data-start])
    const subItems = Array.from(
      document.querySelectorAll('.subtitles-menu li [data-start], .subtitles li [data-start]')
    );
    if (subItems.length > 0) {
      const segments = [];
      for (let i = 0; i < subItems.length; i++) {
        const el = subItems[i];
        const rawStart = parseFloat(el.getAttribute('data-start') || '0');
        const start = rawStart > 1000 ? rawStart / 1000 : rawStart;
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        segments.push({
          start: Math.round(start * 10) / 10,
          duration: 3.5,
          end: Math.round((start + 3.5) * 10) / 10,
          text
        });
      }
      for (let i = 0; i < segments.length - 1; i++) {
        if (segments[i + 1].start > segments[i].start) {
          segments[i].end = segments[i + 1].start;
          segments[i].duration =
            Math.round(Math.max(0.5, segments[i].end - segments[i].start) * 10) / 10;
        }
      }
      if (segments.length > 0) {
        return { languageCode: 'en', languageName: 'en', segments };
      }
    }

    return null;
  }

  /**
   * YouTube-specific metadata & caption retrieval
   */
  async function getYouTubeVideoDataAndTranscript(targetVideoId) {
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

    const innertubePR = await fetchInnertubePlayerResponse(targetVideoId);

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

  /**
   * Unified multi-platform entry point for video metadata + timestamped CC transcript
   */
  async function getVideoDataAndTranscript(targetVideoId) {
    const platform = getPlatform();

    if (
      platform === 'youtube' ||
      (!targetVideoId.startsWith('coursera_') &&
        !targetVideoId.startsWith('edx_') &&
        /^[a-zA-Z0-9_-]{11}$/.test(targetVideoId))
    ) {
      return getYouTubeVideoDataAndTranscript(targetVideoId);
    }

    // Coursera & edX: Wait up to 4.5s for the SPA player to attach <video> tracks or transcript nodes
    let extracted = null;
    let video = null;

    for (let attempt = 0; attempt < 10; attempt++) {
      video = document.querySelector('video.vjs-tech, .rc-VideoPlayer video, .video video, video');
      if (platform === 'edx') {
        extracted = await extractEdxTranscript();
      }
      if (!extracted && video) {
        extracted = await extractHtml5VideoTranscript(video);
      }
      if (!extracted && platform === 'coursera') {
        extracted = extractCourseraDomTranscript();
      }
      if (extracted && extracted.segments && extracted.segments.length > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 450));
    }

    const segments = extracted?.segments || [];
    const lastEnd = segments.length > 0 ? Math.ceil(segments[segments.length - 1].end) : 0;
    const durationSec =
      (video && Number.isFinite(video.duration) && video.duration > 0
        ? Math.round(video.duration)
        : 0) || lastEnd;

    const cleanTitle = (
      document.querySelector('h1')?.textContent ||
      document.title.replace(/\s*[|-]\s*(Coursera|edX).*$/i, '') ||
      'Course Lecture'
    )
      .replace(/\s+/g, ' ')
      .trim();

    const metadata = {
      videoId: targetVideoId,
      title: cleanTitle,
      author: platform === 'coursera' ? 'Coursera Course' : 'edX Course',
      shortDescription: `Educational lecture on ${platform === 'coursera' ? 'Coursera' : 'edX'}`,
      lengthSeconds: durationSec,
      category: 'Education',
      isLiveContent: false,
      keywords: [platform, 'lecture', 'education']
    };

    return {
      metadata,
      hasCaptions: segments.length > 0,
      languageCode: extracted?.languageCode || 'en',
      languageName: extracted?.languageName || 'en',
      isAutoGenerated: false,
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

  // Listen for seek requests from isolated content script across YouTube, Coursera, and edX
  window.addEventListener('YT_TRUTH_SEEK_TO', (event) => {
    const seconds = Number(event.detail?.seconds);
    if (Number.isNaN(seconds)) return;
    const platform = getPlatform();

    if (platform === 'youtube') {
      const isShorts = window.location.pathname.startsWith('/shorts/');
      const player = isShorts
        ? document.getElementById('shorts-player') || document.getElementById('movie_player')
        : document.getElementById('movie_player');
      if (player && typeof player.seekTo === 'function') {
        player.seekTo(seconds, true);
        return;
      }
    }

    if (platform === 'edx' && window.jQuery) {
      try {
        const state = window.jQuery('.video').data('video-player-state');
        if (state?.videoPlayer && typeof state.videoPlayer.onSlideSeek === 'function') {
          state.videoPlayer.onSlideSeek({ type: 'onSlideSeek', time: seconds });
          return;
        }
        if (state?.videoPlayer?.player && typeof state.videoPlayer.player.seekTo === 'function') {
          state.videoPlayer.player.seekTo(seconds, true);
          return;
        }
      } catch {
        // fallback to HTML5 <video> below
      }
    }

    const video =
      document.querySelector('#shorts-player video.html5-main-video') ||
      document.querySelector('ytd-reel-video-renderer[is-active] video') ||
      document.querySelector('video.html5-main-video') ||
      document.querySelector('video.vjs-tech') ||
      document.querySelector('video');
    if (video) {
      video.currentTime = seconds;
    }
  });
})();
