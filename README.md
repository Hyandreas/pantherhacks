# PantherHacks Lumen

Lumen is a privacy-first accessibility assistant for live conversations. It
turns speech into captions, helps users recover missed moments, and keeps
speaker identity useful across web and AR experiences.

## What Is Included

- `web_app/`: React/Vite web captioning interface.
- `ar_app/`: Electron webcam overlay with captions, gesture controls, speaker
  profiles, and translation controls.
- `deepgram_server/`: local WebSocket and HTTP proxy for Deepgram captions and
  shared speaker profiles.

Live captions stream through the local proxy. The Deepgram API key stays in
`deepgram_server/.env` and is never loaded by the web or Electron UI.

## Core Features

### Live Captions

- Streams microphone audio to Deepgram through a local proxy.
- Shows large readable captions for real-time conversation support.
- Uses confidence indicators so uncertain captions are visually called out.
- Keeps a scrollable transcript history in the web app.
- Supports reliable scripted demo scenarios when a microphone or server is not
  available.

### Speaker Profiles

- Automatically creates a profile when a new diarized speaker appears.
- Supports manual profile creation in the web app.
- Profiles include:
  - name / label
  - relation
  - description
  - one or more speaker sources
  - lightweight voice signature data
- Profiles can be created, edited, deleted, refreshed, and saved from the web
  app.
- AR can assign the current speaker to an existing profile or edit the
  automatically created profile.
- Profile edits sync through `deepgram_server` so web and AR share the same
  data.

### Better Speaker Differentiation

- Uses Deepgram diarization speaker IDs instead of treating all live speech as
  one speaker.
- Chooses the dominant speaker across the caption result, not just the first
  word.
- Stores multiple speaker source IDs per profile so assigning a source does not
  overwrite previous identity data.
- Avoids automatically applying weak voice matches. The user must confirm or
  assign profiles directly.

### Missed Moment Repair

- `I missed that` marks the current moment and asks the speaker to repeat.
- Repeated speech is linked back to the missed moment.
- Built-in speaker-facing prompts include:
  - repeat the last part
  - repeat slowly
  - please face me

### Conversation Memory

- Rolling summary of recent captions.
- Action item extraction for names, dates, numbers, rooms, and tasks.
- Tap-to-replay selected captions with browser speech synthesis.
- Explicit save behavior: session memory is kept only when the user chooses to
  save it.

### AR Overlay

- Electron webcam overlay for captioning in a camera-first interface.
- Live caption overlay with confidence bar.
- `Who's this?` button opens a side profile panel for the current speaker.
- Side panel can:
  - edit the automatically created profile
  - assign the speaker to an existing profile
  - create a new profile when needed
  - close with an `x`
- Shared profiles update automatically by polling the local proxy.

### AR Gesture Controls

- Pinch-click support for interacting without a mouse.
- Hold-click support:
  - point at the same button/control for 2 seconds
  - a circular progress donut fills around the cursor
  - when full, it triggers a click
- Gesture clicks work with custom in-page dropdowns for profile assignment and
  translation settings.

### Translation Controls

- Transparent top-right translation pill in AR.
- Opens a nearby modal with:
  - spoken language
  - caption language
- Uses custom gesture-friendly dropdowns instead of native selects.
- Translates AR captions through `deepgram_server` when spoken and caption
  languages differ.
- Uses `LIBRETRANSLATE_URL` when configured, otherwise falls back to MyMemory's
  public translation API.

### Sound Alerts

- Demo scenarios include non-speech sound alerts such as applause, alarm, door
  knock, and name call.
- Critical alerts flash the interface so urgent events are hard to miss.

## Differentiators

- Privacy-first local proxy: API keys stay out of browser and Electron client
  code.
- Accessibility repair loop: Lumen does not only caption; it helps the user ask
  for clarification when captions are uncertain or missed.
- Speaker-aware memory: profiles carry relationship and description context,
  not just raw speaker numbers.
- AR-friendly interaction: pinch and hold gestures support hands-free use.
- Shared profile system: web and AR use the same profile store.
- Consent-aware design: the hearing-side panel explains microphone state,
  saving state, and how speakers can help captions stay reliable.
- Demo-resilient architecture: scripted scenarios keep the product presentable
  even when live audio cannot run.

## Run Deepgram Captions

Create `deepgram_server/.env`:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
DEEPGRAM_MODEL=nova-3
PORT=8788
# Optional translation backend:
# LIBRETRANSLATE_URL=http://127.0.0.1:5000
```

Start the proxy first:

```powershell
cd deepgram_server
npm start
```

The proxy exposes:

- `GET /health`
- `WS /captions`
- `GET /speaker-profiles`
- `POST /speaker-profiles`
- `PUT /speaker-profiles`
- `POST /translate`

Profile editing does not require an admin password.

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

Use the `AR Speaker Profiles` panel to add, edit, assign, delete, refresh, and
save shared profiles.

## Run The AR App

In another terminal:

```powershell
cd ar_app
npm install
npm start
```

Allow camera and microphone access when prompted. Captions appear after Deepgram
returns speech results.

## Typical Demo Flow

1. Start `deepgram_server`.
2. Start `web_app`.
3. Start `ar_app`.
4. Speak near the microphone.
5. When a new speaker appears, Lumen creates a profile automatically.
6. Click or hold-click `Who's this?` in AR.
7. Edit the profile or assign it to an existing one.
8. Confirm the web app reflects the same profile data.
9. Use the translate pill to show spoken/caption language controls.
10. Use `I missed that` in the web app to demonstrate repair flow.

## Privacy And Security Notes

- Do not commit `.env` files.
- Do not paste API keys into client code.
- Audio is streamed to Deepgram through the local proxy for captioning.
- Speaker profiles are stored locally by `deepgram_server`.
- Voice signatures are lightweight local profile metadata and should be treated
  as sensitive user data.

## Verification

Required web verification:

```powershell
cd web_app
npm run build
```

Server syntax check:

```powershell
node --check deepgram_server/server.js
```

AR renderer syntax check:

```powershell
node --check ar_app/renderer.js
```
