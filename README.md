# Truth Bar for YouTube, Coursera & edX — Live AI Fact Checker

A Chrome Extension that automatically fact-checks **YouTube** (`/watch` and `/shorts`), **Coursera**, and **edX** lecture videos in real time as you watch, using the video's Closed Captions (CC) / transcripts and Gemini with Google Search Grounding.

## Quick Setup (Takes ~60 Seconds)

### 1. Install the Extension in Chrome
1. Download or clone this repository to a folder on your computer:
   - [Download ZIP from GitHub](https://github.com/erezbashan/chrome-truth-extension/archive/refs/heads/main.zip) and unzip it.
2. Open Chrome and navigate to `chrome://extensions`.
3. Turn on **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** (top-left button) and select the unzipped `chrome-truth-extension` folder.

### 2. Add Your Free Gemini API Key
1. Go to [Google AI Studio (aistudio.google.com/apikey)](https://aistudio.google.com/apikey) and sign in with your Google account.
2. Click **"Create API key"** (the free tier includes generous daily fact-checking quota).
3. Open any YouTube video — click the **Truth Bar** above the video player (or click the extension icon in Chrome's toolbar), paste your `AIzaSy...` key, and click **Save**.

---

## How It Works
- **Live Status Bar:** Sits directly above the YouTube video player. Stays neutral during casual banter/opinions, and lights up **Green (`✓ TRUE`)**, **Yellow (`⚠ QUESTIONABLE`)**, or **Red (`✗ FALSE`)** when a factual claim is made.
- **Persistent Video Grade:** Displays the video's overall **`% Checkable`** density (how much of the video contains checkable facts vs. opinion/stories) and **`% True`** accuracy score with claim counters (`✓`, `⚠`, `✗`).
- **Colored Timeline Ticks:** Shows every checked claim along a timeline strip. Click any tick to jump to that moment and view the explanation and web sources.
- **Single-Claim Focus & Full Breakdown:** Clicking an active claim opens a compact card with the explanation and clickable Google Search citation links; click **More** to browse or filter all claims in the video.
- **Built-in Feedback:** Click **`✉ Feedback`** inside the bar or extension popup to send feedback, bug reports, or disputed verdicts directly to `erez.bashan@gmail.com`.
