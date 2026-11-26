---
'roboport': patch
---

Add `createTelegramUpdateProcessor` to await a queued Telegram turn, including reply delivery and history writes, without starting a transport. Existing webhook and polling behavior is unchanged.
