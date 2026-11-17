import { CONFIG } from '../config.js';

/**
 * YouTube Truth Bar — Background Service Worker (Manifest V3)
 *
 * Implements the 2-Step Hybrid Fact-Checking Pipeline:
 *  - Step 1: Fast Triage & Exhaustive Claim Extraction (Model Memory, ~1s)
 *  - Step 2: Targeted Google Search Grounding (Only for flagged claims needing live verification/citations)
 */

// Top-level synchronous listener registration (Required by MV3)
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      settings: {
        customApiKey: '',
        geminiModel: CONFIG.GEMINI_MODEL,
        enableSearchGrounding: CONFIG.ENABLE_SEARCH_GROUNDING,
        autoCheck: CONFIG.AUTO_CHECK_BY_DEFAULT,
        lingerDurationSec: CONFIG.LINGER_DURATION_SEC
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case 'GET_CONFIG_AND_CACHE': {
          const settings = await getEffectiveSettings();
          const cache = message.videoId ? await getVideoCache(message.videoId) : null;
          sendResponse({
            ok: true,
            settings: {
              version: CONFIG.VERSION,
              hasApiKey: Boolean(settings.apiKey),
              maskedKey: maskApiKey(settings.apiKey),
              geminiModel: settings.geminiModel,
              enableSearchGrounding: settings.enableSearchGrounding,
              autoCheck: settings.autoCheck,
              chunkDurationSec: CONFIG.CHUNK_DURATION_SEC,
              lookaheadBufferSec: CONFIG.LOOKAHEAD_BUFFER_SEC,
              lingerDurationSec: settings.lingerDurationSec
            },
            cache
          });
          break;
        }

        case 'SAVE_SETTINGS': {
          const current = (await chrome.storage.local.get('settings')).settings || {};
          const updated = { ...current, ...message.settings };
          await chrome.storage.local.set({ settings: updated });
          const effective = await getEffectiveSettings();
          sendResponse({
            ok: true,
            settings: {
              version: CONFIG.VERSION,
              hasApiKey: Boolean(effective.apiKey),
              maskedKey: maskApiKey(effective.apiKey),
              geminiModel: effective.geminiModel,
              enableSearchGrounding: effective.enableSearchGrounding,
              autoCheck: effective.autoCheck,
              chunkDurationSec: CONFIG.CHUNK_DURATION_SEC,
              lookaheadBufferSec: CONFIG.LOOKAHEAD_BUFFER_SEC,
              lingerDurationSec: effective.lingerDurationSec
            }
          });
          break;
        }

        case 'CLEAR_VIDEO_CACHE': {
          if (message.videoId) {
            await chrome.storage.local.remove(`video_cache_${message.videoId}`);
          }
          sendResponse({ ok: true });
          break;
        }

        case 'FETCH_VIDEO_TRANSCRIPT': {
          const data = await fetchTranscriptFromServiceWorker(message.videoId);
          sendResponse({ ok: true, data });
          break;
        }

        case 'ANALYZE_CHUNK': {
          const tabId = sender.tab?.id;
          const result = await handleAnalyzeChunk(message.payload, tabId);
          sendResponse(result);
          break;
        }

        default:
          sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err?.message || String(err) });
    }
  })();
  return true; // Keep message channel open for async response
});

function maskApiKey(key) {
  if (!key || key.length < 8) return '';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

const DEPRECATED_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash']);

async function getEffectiveSettings() {
  const stored = (await chrome.storage.local.get('settings')).settings || {};
  const codeKey =
    CONFIG.GEMINI_API_KEY &&
    CONFIG.GEMINI_API_KEY !== 'YOUR_GEMINI_API_KEY_HERE' &&
    CONFIG.GEMINI_API_KEY.trim() !== ''
      ? CONFIG.GEMINI_API_KEY.trim()
      : '';
  const customKey = (stored.customApiKey || '').trim();

  let model = stored.geminiModel || CONFIG.GEMINI_MODEL || 'gemini-3.8-flash';
  if (DEPRECATED_MODELS.has(model)) {
    model = CONFIG.GEMINI_MODEL || 'gemini-3.8-flash';
  }

  return {
    apiKey: customKey || codeKey,
    geminiModel: model,
    enableSearchGrounding:
      typeof stored.enableSearchGrounding === 'boolean'
        ? stored.enableSearchGrounding
        : CONFIG.ENABLE_SEARCH_GROUNDING,
    autoCheck:
      typeof stored.autoCheck === 'boolean' ? stored.autoCheck : CONFIG.AUTO_CHECK_BY_DEFAULT,
    lingerDurationSec:
      typeof stored.lingerDurationSec === 'number'
        ? stored.lingerDurationSec
        : CONFIG.LINGER_DURATION_SEC
  };
}

async function getVideoCache(videoId) {
  const key = `video_cache_${videoId}`;
  const data = await chrome.storage.local.get(key);
  return data[key] || null;
}

async function saveVideoCache(videoId, cacheData) {
  const key = `video_cache_${videoId}`;
  await chrome.storage.local.set({ [key]: cacheData });
}

function formatSec(sec) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

function decodeHtmlEntitiesSW(str) {
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

function parseXmlTranscriptSW(xmlText) {
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
    const text = decodeHtmlEntitiesSW(rawContent).replace(/\s+/g, ' ').trim();
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
    const text = decodeHtmlEntitiesSW(rawContent).replace(/\s+/g, ' ').trim();
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

function selectBestCaptionTrackSW(renderer) {
  const tracks = renderer?.captionTracks || [];
  if (tracks.length === 0) return null;
  if (tracks.length === 1) return tracks[0];

  // 1. Check YouTube's defaultAudioTrackIndex / original audioTrack (.4) -> captionTrackIndices[0]
  //    (Avoids picking "Arabic" first on multi-language auto-dubbed videos where tracks are sorted alphabetically!)
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

  // 2. Fallback: prefer manual tracks, and prefer English (en*) or Hebrew (iw/he) over alphabetical index 0
  const isPreferredLang = (code) => /^(en|iw|he)(-|$)/i.test(String(code || ''));
  const manual = tracks.filter((t) => t.kind !== 'asr');
  if (manual.length > 0) {
    return manual.find((t) => isPreferredLang(t.languageCode)) || manual[0];
  }
  return tracks.find((t) => isPreferredLang(t.languageCode)) || tracks[0];
}

async function fetchTranscriptFromServiceWorker(videoId) {
  const clients = [
    { clientName: 'IOS', clientVersion: '20.10.4' },
    { clientName: 'ANDROID', clientVersion: '20.10.38' }
  ];

  for (const client of clients) {
    try {
      const resp = await fetch('https://www.youtube.com/youtubei/v1/player', {
        method: 'POST',
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
      const pr = await resp.json();
      const renderer = pr?.captions?.playerCaptionsTracklistRenderer;
      const chosen = selectBestCaptionTrackSW(renderer);
      if (!chosen) continue;

      const tResp = await fetch(chosen.baseUrl);
      if (!tResp.ok) continue;
      const xml = await tResp.text();
      const segments = parseXmlTranscriptSW(xml);
      if (segments.length > 0) {
        const details = pr.videoDetails || {};
        const micro = pr.microformat?.playerMicroformatRenderer || {};
        return {
          metadata: {
            videoId,
            title: details.title || '',
            author: details.author || '',
            shortDescription: (details.shortDescription || '').slice(0, 1200),
            lengthSeconds: parseInt(details.lengthSeconds || '0', 10) || 0,
            category: micro.category || '',
            isLiveContent: Boolean(details.isLiveContent),
            keywords: Array.isArray(details.keywords) ? details.keywords.slice(0, 15) : []
          },
          hasCaptions: true,
          languageCode: chosen.languageCode || 'en',
          languageName: chosen.name?.simpleText || chosen.languageCode || 'en',
          isAutoGenerated: chosen.kind === 'asr',
          segments
        };
      }
    } catch {
      // try next client
    }
  }
  return { hasCaptions: false, segments: [] };
}

/**
 * Merge tiny 2-3s caption fragments into ~12s blocks to reduce prompt token overhead by ~45%
 */
function formatCompactTranscriptLines(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const merged = [];
  let cur = null;

  for (const seg of segments) {
    if (!cur) {
      cur = { start: seg.start, end: seg.end, texts: [seg.text] };
    } else if (seg.end - cur.start <= 12) {
      cur.end = seg.end;
      cur.texts.push(seg.text);
    } else {
      merged.push(cur);
      cur = { start: seg.start, end: seg.end, texts: [seg.text] };
    }
  }
  if (cur) merged.push(cur);

  return merged
    .map((m) => `[${Math.round(m.start)}s-${Math.round(m.end)}s] ${m.texts.join(' ')}`)
    .join('\n');
}

/**
 * Step 1: Fast Triage & Exhaustive Claim Extraction (No search tool attached for speed & quota savings)
 */
async function runStep1Triage({ metadata, chunk, isFirstChunk, languageCode }, settings) {
  const transcriptLines = formatCompactTranscriptLines(chunk.segments);

  const currentYear = new Date().getFullYear();

  const prompt = `You are an expert, rigorous, non-partisan fact-checker analyzing a YouTube video transcript chunk.
Current year: ${currentYear}.

VIDEO METADATA:
- Title: ${metadata.title || 'Unknown'}
- Channel/Author: ${metadata.author || 'Unknown'}
- Category: ${metadata.category || 'Unknown'}
- Description snippet: ${(metadata.shortDescription || '').slice(0, 500)}
- Transcript Language Code: ${languageCode || 'en'}

CHUNK INFO:
- Chunk Index: ${chunk.index} (${formatSec(chunk.startTime)} to ${formatSec(chunk.endTime)})
- Is First Analyzed Chunk: ${isFirstChunk ? 'YES' : 'NO'}

TRANSCRIPT SEGMENTS IN THIS CHUNK:
${transcriptLines}

INSTRUCTIONS:
1. LANGUAGE: Write all output text fields ("irrelevantReason", "chunkSummary", "claimText", "explanation") in the SAME language as the transcript (language code: "${languageCode || 'en'}"). If the language cannot be determined, use English.
2. VIDEO RELEVANCE ("isVideoRelevant"):
   - Set "isVideoRelevant" to FALSE ONLY if this video is clearly NOT applicable for factual verification — such as a music video / song lyrics, fictional movie / drama / story, comedy sketch, ASMR, or pure entertainment/gameplay with zero factual assertions about the real world.
   - If "isVideoRelevant" is FALSE, set "irrelevantReason" to a short 2-4 word label (e.g., "Fictional TV Clip", "Music Video", "Comedy Sketch").
   - Set "isVideoRelevant" to TRUE if the video discusses real-world events, news, politics, history, science, health, economics, technology, biographies, educational content, product claims, or commentary with checkable facts.
3. FACTUAL DENSITY ("chunkFactualPercentage"):
   - Estimate what percentage (0 to 100) of this transcript chunk consists of checkable factual statements about the real world versus opinions, jokes, greetings, sponsor reads, rhetorical questions, or casual banter.
   - CONSISTENCY RULE: If "chunkFactualPercentage" > 0, you MUST extract the checkable factual claim(s) in the "claims" array below. Only return an empty "claims" array ([]) when there are truly 0 checkable factual claims (in which case "chunkFactualPercentage" MUST be 0).
4. EXTRACT ALL FACTUAL CLAIMS ("claims"):
   - Do NOT summarize the chunk into just 1 or 2 takeaways! Extract EVERY distinct verifiable factual claim made in this chunk.
   - Skip pure subjective opinions ("I love this movie"), jokes/sarcasm, greetings, and transitional filler.
   - For each factual claim:
     - "startTime": exact start time in seconds (number) from the transcript segment where the claim begins.
     - "endTime": exact end time in seconds (number) where the claim finishes.
     - "claimText": concise quote or faithful summary of the specific claim made by the speaker.
     - "verdict":
       - "TRUE" = Factually accurate and supported by consensus evidence.
       - "QUESTIONABLE" = Misleading, missing crucial context, exaggerated, cherry-picked, unsubstantiated, or mixed accuracy.
       - "FALSE" = Outright false, fabricated, or directly contradicted by established facts.
     - "explanation": 1-2 crisp sentences explaining the verdict with the actual facts/numbers.
     - "needsSearch": Set to TRUE if:
       (a) The claim cites specific statistics, dates, or numbers you aren't 100% certain of, OR
       (b) The claim involves recent events (2024-${currentYear}) or current positions/records, OR
       (c) You marked the claim as "QUESTIONABLE" or "FALSE" and live web verification / source citations would strengthen the proof.
       Set to FALSE if it is a timeless, well-established fact (or obvious falsehood) that requires no web search.
     - "searchQuery": If "needsSearch" is true, provide a concise, specific Google Search query to verify this claim. Otherwise empty string.

Respond ONLY with valid JSON matching this schema:
{
  "isVideoRelevant": boolean,
  "irrelevantReason": string,
  "chunkFactualPercentage": number,
  "chunkSummary": string,
  "claims": [
    {
      "startTime": number,
      "endTime": number,
      "claimText": string,
      "verdict": "TRUE" | "QUESTIONABLE" | "FALSE",
      "explanation": string,
      "needsSearch": boolean,
      "searchQuery": string
    }
  ]
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    settings.geminiModel
  )}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    let msg = `Gemini API Error (${response.status})`;
    try {
      const errJson = JSON.parse(errText);
      if (errJson.error?.message) msg = errJson.error.message;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  const data = await response.json();
  const rawText =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '{}';

  const parsed = parseJsonSafely(rawText);
  const rawClaims = Array.isArray(parsed.claims) ? parsed.claims : [];

  const normalizedClaims = rawClaims.map((c, idx) => {
    const start = typeof c.startTime === 'number' ? c.startTime : chunk.startTime;
    const end =
      typeof c.endTime === 'number' && c.endTime >= start ? c.endTime : start + 4;
    const verdict = ['TRUE', 'QUESTIONABLE', 'FALSE'].includes(
      String(c.verdict || '').toUpperCase()
    )
      ? String(c.verdict).toUpperCase()
      : 'QUESTIONABLE';

    return {
      id: `c_${chunk.index}_${idx}_${Math.round(start)}`,
      chunkIndex: chunk.index,
      startTime: start,
      endTime: end,
      claimText: String(c.claimText || '').trim(),
      verdict,
      explanation: String(c.explanation || '').trim(),
      needsSearch: Boolean(c.needsSearch),
      searchQuery: String(c.searchQuery || '').trim(),
      verifyingWithSearch: Boolean(c.needsSearch && settings.enableSearchGrounding),
      searchVerified: false,
      sources: []
    };
  });

  return {
    isVideoRelevant: parsed.isVideoRelevant !== false,
    irrelevantReason: String(parsed.irrelevantReason || '').trim(),
    chunkFactualPercentage:
      normalizedClaims.length === 0
        ? 0
        : typeof parsed.chunkFactualPercentage === 'number'
        ? Math.max(5, Math.min(100, Math.round(parsed.chunkFactualPercentage)))
        : 30,
    chunkSummary: String(parsed.chunkSummary || '').trim(),
    claims: normalizedClaims
  };
}

/**
 * Step 2: Targeted Google Search Grounding for claims flagged with needsSearch = true
 */
async function runStep2SearchGrounding({ metadata, claimsToVerify, languageCode }, settings) {
  if (!claimsToVerify || claimsToVerify.length === 0) return [];

  const currentYear = new Date().getFullYear();
  const claimsPayload = claimsToVerify.map((c) => ({
    id: c.id,
    startTime: c.startTime,
    claimText: c.claimText,
    initialVerdict: c.verdict,
    initialExplanation: c.explanation,
    searchQuery: c.searchQuery
  }));

  const prompt = `You are verifying specific factual claims from the YouTube video "${metadata.title}" by "${metadata.author}" using live Google Search.
Current year: ${currentYear}.
Output language code: "${languageCode || 'en'}" (Keep "explanation" in the same language as "claimText").

Use Google Search to verify each of the following claims and provide an updated verdict ("TRUE", "QUESTIONABLE", or "FALSE") and a concise 1-2 sentence fact-check explanation based on live web sources:

CLAIMS TO VERIFY:
${JSON.stringify(claimsPayload, null, 2)}

Return ONLY a JSON object (no markdown fences needed, or inside a \`\`\`json block) with this exact structure:
{
  "verifiedClaims": [
    {
      "id": "claim id from input",
      "verdict": "TRUE" | "QUESTIONABLE" | "FALSE",
      "explanation": "Updated 1-2 sentence explanation with verified facts",
      "sources": [
        { "title": "Source Name", "url": "https://..." }
      ]
    }
  ]
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    settings.geminiModel
  )}:generateContent?key=${encodeURIComponent(settings.apiKey)}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: {
        temperature: 0.1
      }
    })
  });

  if (!response.ok) {
    throw new Error(`Search Grounding HTTP ${response.status}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0] || {};
  const rawText =
    candidate.content?.parts?.map((p) => p.text || '').join('') || '{}';

  // Extract grounding chunks from Gemini's native groundingMetadata
  const groundingChunks = candidate.groundingMetadata?.groundingChunks || [];
  const groundingSources = [];
  for (const gc of groundingChunks) {
    if (gc.web?.uri) {
      groundingSources.push({
        title: gc.web.title || new URL(gc.web.uri).hostname,
        url: gc.web.uri
      });
    }
  }

  const parsed = parseJsonSafely(rawText);
  const verifiedList = Array.isArray(parsed.verifiedClaims) ? parsed.verifiedClaims : [];

  return verifiedList.map((vc) => {
    const verdict = ['TRUE', 'QUESTIONABLE', 'FALSE'].includes(
      String(vc.verdict || '').toUpperCase()
    )
      ? String(vc.verdict).toUpperCase()
      : null;

    const modelSources = Array.isArray(vc.sources)
      ? vc.sources
          .filter((s) => s && typeof s.url === 'string' && s.url.startsWith('http'))
          .map((s) => ({ title: s.title || s.url, url: s.url }))
      : [];

    // Combine model-listed sources with groundingMetadata sources (deduplicated)
    const combinedSources = [...modelSources];
    for (const gs of groundingSources) {
      if (combinedSources.length < 4 && !combinedSources.some((s) => s.url === gs.url)) {
        combinedSources.push(gs);
      }
    }

    return {
      id: vc.id,
      verdict,
      explanation: vc.explanation ? String(vc.explanation).trim() : null,
      sources: combinedSources.slice(0, 4)
    };
  });
}

function parseJsonSafely(text) {
  if (!text) return {};
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try extracting from ```json ... ``` or first { ... }
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // continue
      }
    }
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
      } catch {
        return {};
      }
    }
    return {};
  }
}

/**
 * Orchestrates Step 1 and Step 2 for a single chunk and persists to chrome.storage.local
 */
async function handleAnalyzeChunk(payload, tabId) {
  const { videoId, metadata, chunk, isFirstChunk, totalChunks, languageCode } = payload;
  const settings = await getEffectiveSettings();

  if (!settings.apiKey) {
    return {
      ok: false,
      code: 'MISSING_API_KEY',
      error: 'Gemini API key is not configured. Add it in config.js or click the extension icon.'
    };
  }

  // Check if chunk is already cached
  let videoCache = (await getVideoCache(videoId)) || {
    videoId,
    metadata,
    languageCode,
    totalChunks,
    isVideoRelevant: true,
    irrelevantReason: '',
    chunks: {},
    updatedAt: Date.now()
  };

  if (videoCache.chunks[chunk.index]?.step2Done) {
    return {
      ok: true,
      cached: true,
      chunkResult: videoCache.chunks[chunk.index],
      videoCache
    };
  }

  // Run Step 1: Fast Triage + Model Memory Check
  const step1Result = await runStep1Triage(
    { metadata, chunk, isFirstChunk, languageCode },
    settings
  );

  // Re-fetch cache in case another chunk updated it concurrently
  videoCache = (await getVideoCache(videoId)) || videoCache;
  videoCache.totalChunks = totalChunks || videoCache.totalChunks;

  if (isFirstChunk && !step1Result.isVideoRelevant && step1Result.claims.length === 0) {
    videoCache.isVideoRelevant = false;
    videoCache.irrelevantReason =
      step1Result.irrelevantReason || 'Not applicable for fact-checking';
  } else if (step1Result.isVideoRelevant || step1Result.claims.length > 0) {
    videoCache.isVideoRelevant = true;
  }

  const claimsNeedingSearch = settings.enableSearchGrounding
    ? step1Result.claims.filter((c) => c.needsSearch)
    : [];

  const chunkRecord = {
    index: chunk.index,
    startTime: chunk.startTime,
    endTime: chunk.endTime,
    chunkFactualPercentage: step1Result.chunkFactualPercentage,
    chunkSummary: step1Result.chunkSummary,
    claims: step1Result.claims,
    step1Done: true,
    step2Done: claimsNeedingSearch.length === 0
  };

  videoCache.chunks[chunk.index] = chunkRecord;
  videoCache.updatedAt = Date.now();
  await saveVideoCache(videoId, videoCache);

  // Immediately notify the tab about Step 1 results so the bar updates in ~1s
  if (tabId) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'CHUNK_UPDATED',
        phase: 'STEP1',
        videoId,
        chunkIndex: chunk.index,
        chunkResult: chunkRecord,
        videoCache
      });
    } catch {
      // Tab may have closed or navigated
    }
  }

  // Run Step 2: Targeted Google Search Grounding if any claims need search verification
  if (claimsNeedingSearch.length > 0 && videoCache.isVideoRelevant) {
    try {
      const verifiedList = await runStep2SearchGrounding(
        { metadata, claimsToVerify: claimsNeedingSearch, languageCode },
        settings
      );

      const verifiedMap = new Map(verifiedList.map((v) => [v.id, v]));
      chunkRecord.claims = chunkRecord.claims.map((claim) => {
        if (!claim.needsSearch) return claim;
        const verified = verifiedMap.get(claim.id);
        if (!verified) {
          return { ...claim, verifyingWithSearch: false };
        }
        return {
          ...claim,
          verdict: verified.verdict || claim.verdict,
          explanation: verified.explanation || claim.explanation,
          sources: verified.sources || [],
          verifyingWithSearch: false,
          searchVerified: true
        };
      });
    } catch (searchErr) {
      // Graceful fallback: keep Step 1 verdict if search quota or network fails
      console.warn('Step 2 Search Grounding fallback to Step 1:', searchErr);
      chunkRecord.claims = chunkRecord.claims.map((claim) => ({
        ...claim,
        verifyingWithSearch: false
      }));
    }

    chunkRecord.step2Done = true;
    videoCache = (await getVideoCache(videoId)) || videoCache;
    videoCache.chunks[chunk.index] = chunkRecord;
    videoCache.updatedAt = Date.now();
    await saveVideoCache(videoId, videoCache);

    if (tabId) {
      try {
        await chrome.tabs.sendMessage(tabId, {
          type: 'CHUNK_UPDATED',
          phase: 'STEP2',
          videoId,
          chunkIndex: chunk.index,
          chunkResult: chunkRecord,
          videoCache
        });
      } catch {
        // Tab may have closed
      }
    }
  }

  return {
    ok: true,
    cached: false,
    chunkResult: chunkRecord,
    videoCache
  };
}
