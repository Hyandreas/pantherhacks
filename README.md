# PantherHacks Lumen

This repository contains:

- `web_app/`: the React/Vite Lumen captioning prototype.
- `ar_app/`: the Electron webcam overlay widget.
- `deepgram_server/`: the local Deepgram WebSocket proxy for live captions.

Live captions use Deepgram streaming through a local proxy. The Deepgram API key
stays in `deepgram_server/.env` and is never loaded by the web or Electron UI.

## Run Deepgram Captions

Create `deepgram_server/.env`:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
DEEPGRAM_MODEL=nova-3
PORT=8788
LUMEN_ADMIN_TOKEN=change-this-local-password
```

Start the proxy first:

```powershell
cd deepgram_server
npm start
```

## Run The Web App

In a second terminal:

```powershell
cd web_app
npm install
npm run dev:clean
```

Open:

```text
http://127.0.0.1:3000
```

## Run The AR App

In a second terminal:

```powershell
cd ar_app
npm install
npm start
```

Allow camera and microphone access when prompted. Captions appear only after
Deepgram returns speech results.

## Notes

The local proxy listens on `ws://127.0.0.1:8788/captions`. The web app uses
`LUMEN_ADMIN_TOKEN` to edit shared speaker labels, and the AR app reads those
labels from the proxy. Do not commit `.env` files or paste API keys into client
code.

Open the web app's `AR Speaker Profiles` panel, sign in with
`LUMEN_ADMIN_TOKEN`, edit labels, and click `Save labels`. The AR app polls the
proxy and reflects saved label changes automatically.

AR also stores a lightweight voice signature with each confirmed profile. On a
future session it can suggest a likely match, but the user must confirm before a
label is applied.
