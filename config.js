/**
 * YouTube Truth Bar — Configuration
 *
 * NOTE ON CREDENTIALS & GIT SECURITY:
 * Because this repository is pushed to GitHub, do NOT commit a live API key in this file
 * (Google automatically revokes leaked AIzaSy... keys pushed to GitHub).
 * Instead, local credentials are automatically read from `config.local.json` (which is git-ignored)
 * or from the Extension Popup / inline drawer.
 */
export const CONFIG = {
  // Extension build version (displayed in GUI per project rules; increment on each build)
  VERSION: '1.0.16',

  // Fallback placeholder if config.local.json or popup override is not present
  GEMINI_API_KEY: 'YOUR_GEMINI_API_KEY_HERE',

  // Fast Gemini model used for both Step 1 (Triage) and Step 2 (Google Search Grounding)
  GEMINI_MODEL: 'gemini-3.8-flash',

  // Duration of each on-demand transcript window in seconds (15 minutes = 900s)
  // Large enough to minimize API calls (1 call covers 15 mins from current playback position)
  CHUNK_DURATION_SEC: 900,

  // Only prefetch the next 15-minute window when playback is within this many seconds of the end of the current window
  LOOKAHEAD_BUFFER_SEC: 60,

  // How many seconds a claim stays highlighted on the live bar after the speaker finishes the sentence
  LINGER_DURATION_SEC: 10,

  // Enable Step 2 Google Search Grounding for claims flagged as needing live web verification
  ENABLE_SEARCH_GROUNDING: true,

  // Automatically start fact-checking in parallel when a YouTube video plays
  AUTO_CHECK_BY_DEFAULT: true
};
