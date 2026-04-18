# Lumen Deepgram Server

Local WebSocket proxy for Lumen captions. It keeps the Deepgram API key out of
the web app and Electron renderer.

The proxy enables Deepgram diarization so clients can receive session-local
speaker IDs for rename prompts.

## Setup

Create `deepgram_server/.env`:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
DEEPGRAM_MODEL=nova-3
PORT=8788
# Optional. If omitted, /translate uses MyMemory's public translation API.
# LIBRETRANSLATE_URL=http://127.0.0.1:5000
```

## Run

```powershell
cd deepgram_server
npm start
```

The proxy exposes:

- `GET /health`
- `WS /captions`
- `POST /auth/login`
- `GET /speaker-profiles`
- `POST /speaker-profiles`
- `PUT /speaker-profiles`
- `POST /translate`

Start this server before running `web_app` or `ar_app`.
