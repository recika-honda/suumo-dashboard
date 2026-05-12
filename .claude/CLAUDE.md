# suumo-dashboard — Project Rules

## Overview
End-to-end REINS-to-SUUMO listing automation dashboard with AI image classification, real-time progress via WebSocket.

## Tech Stack
- Next.js 15 (App Router) + custom Express server with Socket.IO for real-time updates
- React 19, Tailwind CSS 4, Framer Motion
- Playwright for REINS/SUUMO/ForRent browser automation
- Anthropic SDK for AI image analysis and text generation (`skills/image-ai.js`, `skills/text-ai.js`)
- Sharp for image processing, Notion SDK, Slack Web API
- JavaScript (no TypeScript)

## Key Notes
- Dev: `bun run dev` / Prod: `bun run start` — both use `server.js` (Express + Next.js + Socket.IO)
- Skills layer in `skills/`: reins, forrent, bukaku-images, google-images, google-maps, image-ai, text-ai, score-checker, suumo-check, transport-filler
- Batch/debug scripts in `scripts/` (e.g., `reins-to-notion.js`, `batch-test.js`)
- Requires `.env.local` with REINS/SUUMO credentials, Notion token, Anthropic API key, Slack token
