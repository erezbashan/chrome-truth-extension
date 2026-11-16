# Chrome Web Store Listing — Truth Bar for YouTube — Live AI Fact Checker

> Last Updated: 2026-11-16

## Store Listing

**Extension Name** [REQUIRED]
Truth Bar for YouTube — Live AI Fact Checker

**Short Description** [REQUIRED]
Real-time fact-checking bar for YouTube videos. Highlights true, questionable, and false claims as you watch with web citations.

**Detailed Description** [REQUIRED]
Truth Bar for YouTube adds a live fact-checking bar directly above the YouTube video player so you can verify factual claims as you watch.

Key Features:
• Live Verdict Bar: Stays calm during opinions and casual talk, and lights up Green (True), Yellow (Questionable), or Red (False) when the speaker makes a factual claim.
• Persistent Video Score: Shows at a glance what percentage of the video contains checkable factual claims and the overall accuracy score across verified statements.
• Interactive Timeline Markers: Colored ticks along the timeline show where true, questionable, and false claims occur. Click any marker to jump directly to that timestamp.
• Web-Verified Sources: Click any active claim to read a concise explanation and open clickable web source links.
• Smart On-Demand Checking: Starts automatically from your current playback position without interrupting or slowing down video playback.

How to Use:
1. Install the extension and open any YouTube video (or click the extension icon in your toolbar).
2. Create a free Gemini API key at Google AI Studio (aistudio.google.com/apikey) and paste it into the extension.
3. Watch any YouTube video with Closed Captions — the Truth Bar automatically checks claims in the background as you watch.

Privacy & Security:
Your API key and cached fact-check results are stored strictly locally in your browser. Transcript segments are sent directly from your browser to the Google Gemini API solely to evaluate factual claims in the video you are watching.

Support & Feedback:
Use the built-in Feedback button in the extension or email erez.bashan@gmail.com.

**Category** [REQUIRED]
News & Weather

**Single Purpose** [REQUIRED]
Fact-checks spoken claims in YouTube videos using closed captions and displays real-time verdicts and source citations above the video player.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | ⬜ Capture from YouTube | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Optional | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Stores the user's Gemini API key, user preferences (model selection, linger duration, auto-check toggle), and locally cached fact-check results per video so re-watching a video does not repeat API calls. |
| `https://*.youtube.com/*` | host_permissions | Needed to display the live fact-check bar above the YouTube video player and read the video's Closed Captions track so spoken claims can be evaluated. |
| `https://generativelanguage.googleapis.com/*` | host_permissions | Needed to send video transcript segments from the user's browser to the Google Gemini API for claim extraction and Google Search grounded fact verification. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

| Data Type | Collected? | Transmitted Off-Device? | Purpose | Shared with Third Parties? |
|-----------|-----------|------------------------|---------|---------------------------|
| Personally identifiable info | No | No | N/A | No |
| Authentication info | Stored locally only | Sent only to `generativelanguage.googleapis.com` | User's own Gemini API key authenticates requests to Google Gemini API | No |
| Website content | Yes (YouTube video captions only) | Sent to `generativelanguage.googleapis.com` | Evaluates factual claims in the currently watched YouTube video | Only Google Gemini API |

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Distribution

**Visibility**: Unlisted (for sharing via direct link with friends) or Public
**Regions**: All regions

## Developer Info

**Publisher Name**: Erez Bashan
**Contact Email**: erez.bashan@gmail.com
**Support Email**: erez.bashan@gmail.com
**Homepage URL**: https://github.com/erezbashan/chrome-truth-extension

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.0.11 | 2026-11-16 | Added guided Gemini API key setup, inline & popup feedback form to erez.bashan@gmail.com, claim dispute button, and CWS metadata | Draft |
