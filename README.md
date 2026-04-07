# Polymarket Whip 🎯

A Chrome extension that lets you crack the whip on Polymarket prediction market charts.

## How it works

| Action | Effect |
|---|---|
| **Space + W** (1st) | Whip spawns at your cursor — move the mouse fast to crack it. Probability bumps up. |
| **Space + W** (2nd) | Another crack — probability climbs higher. |
| **Space + W** (3rd) | Final crack — probability hits **100%** + celebration confetti 🎉 |
| **Space + W** (4th) | Everything resets to the original state. Deactivated until page reload. |

Visual effects only — no interaction with any API or real market data.

## Install (Developer Mode)

1. Clone the repo:
   ```bash
   git clone https://github.com/shtanga0x/polymarket-whip.git
   ```
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `polymarket-whip` folder
5. Navigate to any [Polymarket](https://polymarket.com) market page and press **Space + W**

## Optional: Crack sounds

Copy `A.mp3` – `E.mp3` from the [badclaude](https://github.com/GitFrog1111/badclaude) repo into the `sounds/` folder for satisfying whip crack audio.

## Credits

Whip physics ported from [badclaude](https://github.com/GitFrog1111/badclaude) — Verlet integration, Catmull-Rom splines, full crack detection.

---

> Follow for more tools and experiments:
> **Telegram:** [t.me/shtanga0x](https://t.me/shtanga0x)
