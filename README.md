# Bumble Insight

A Chrome extension that adds a floating profile panel to Bumble's swipe page, surfacing information from the server that the app doesn't display in its UI.

---

## What It Shows

For every profile in your current queue:

- **Name, age, and verification status**
- **Voted status** — whether this person has already voted on your profile
- **Their choice** — whether they liked you (shown only when the server confirms they voted)
- **Lifestyle details** — looking for, height, drinking, smoking, kids, exercise, star sign, politics, education level
- **About me** text and any open-ended question answers
- **Photo count**

The full queue is shown as a stack — not just the current card, but all upcoming profiles already loaded by the app. Profiles disappear from the queue the moment you swipe on them.

---

## Installation

1. Download this repository as a ZIP and extract it, or clone it
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** using the toggle in the top-right corner
4. Click **Load unpacked** and select the extension folder
5. Go to `bumble.com` and navigate to the swipe page

---

## Usage

| Action | How |
|---|---|
| Move the panel | Click and drag the header bar |
| Collapse / expand | Click the `−` button in the header |
| Toggle dark mode | Click the sun/moon icon in the header |

Dark mode preference is saved automatically and restored on the next visit.

---

## How It Works

Bumble's web app communicates with its backend through `XMLHttpRequest` to `/mwebapi.phtml`, using a custom RPC protocol (`badoo.bma.BadooMessage`). The extension wraps `XMLHttpRequest.prototype.open` and `.send` at the page level to read both outgoing votes and incoming profile data before the app processes them.

**Incoming data** (message type 84) contains a `results` array where each entry holds a `has_user_voted` flag — information the app's internal parser discards before it ever reaches the UI. The extension captures this directly from the raw response and uses it as the authoritative source for voted status.

**Outgoing votes** (message type 80) are intercepted so the panel can immediately remove a profile from the queue the moment you swipe, keeping the stack in sync with your actions.

---

## Debug

Open DevTools on `bumble.com` swipe page and run:

```js
// All loaded profiles in queue order
window.__bumbleInsight.orderedProfiles()

// Raw profile store (Map: userId → profile)
window.__bumbleInsight.store

// Queue order (array of userIds)
window.__bumbleInsight.order
```