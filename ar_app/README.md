# Lumen AR Webcam Widget

Electron webcam overlay with transparent Deepgram captions.
When Deepgram diarization reports a new speaker, the overlay shows a clickable
prompt so the user can save a local speaker label.

Hand UI:
- Raise your pointer finger to show the cursor (index fingertip).
- Pinch thumb to pointer fingertip to click.

## Install

```powershell
cd ar_app
npm install
```

## Run

Start the shared caption proxy first:

```powershell
cd ..\deepgram_server
npm start
```

Then start the widget:

```powershell
cd ..\ar_app
npm start
```

Allow camera and microphone permission if prompted.

## Files

- `main.js` creates the frameless, transparent Electron window.
- `index.html` contains the webcam view and caption overlay.
- `renderer.js` streams microphone chunks, handles diarized speakers, and stores local speaker labels.
- `styles.css` controls the rounded webcam window and transparent caption UI.

Speaker labels are local convenience profiles. They do not automatically verify
the same real person across future sessions.

The AR app reads shared labels from `deepgram_server` every few seconds, so
labels edited in the web app appear in the overlay without restarting AR.

When a user saves a label, AR stores a lightweight local voice signature with
that profile. In later sessions it can suggest a match such as `Sounds like
Doctor`, but the user still has to tap to confirm before the label is applied.
