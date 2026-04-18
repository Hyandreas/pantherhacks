const DEEPGRAM_PROXY_URL = "ws://127.0.0.1:8788/captions";
const SPEAKER_PROFILES_URL = "http://127.0.0.1:8788/speaker-profiles";
const MEDIAPIPE_HANDS_BASE_URL = new URL(
  "./node_modules/@mediapipe/hands/",
  window.location.href,
).toString();
const CHUNK_MS = 250;

const video = document.querySelector("#cameraFeed");
const errorMessage = document.querySelector("#cameraError");
const closeButton = document.querySelector("#closeButton");
const captionOverlay = document.querySelector("#captionOverlay");
const captionStatus = document.querySelector("#captionStatus");
const captionText = document.querySelector("#captionText");
const confidenceBar = document.querySelector("#confidenceBar span");
const speakerPrompt = document.querySelector("#speakerPrompt");
const speakerPromptButton = document.querySelector("#speakerPromptButton");
const speakerPromptName = document.querySelector("#speakerPromptName");
const speakerPromptForm = document.querySelector("#speakerPromptForm");
const speakerNameInput = document.querySelector("#speakerNameInput");
const speakerLaterButton = document.querySelector("#speakerLaterButton");
const handCursor = document.querySelector("#handCursor");
const handStatus = document.querySelector("#handStatus");

let captionSocket = null;
let recorder = null;
let micStream = null;
let voiceAudioContext = null;
let voiceAnalyser = null;
let voiceInterval = null;
let currentVoiceSignature = null;
let lastTranscript = "";
let pendingSpeakerId = null;
let pendingMatchProfileId = null;
let handTracker = null;
let pinchDown = false;
let lastCursorPoint = null;
let handSendFailures = 0;
let handFrameBusy = false;
let lastHandFrameAt = 0;
let handRestartInProgress = false;
let lastHandRestartAt = 0;
let handFrameIntervalMs = 67;
let lastHandErrorText = "";
let handModelReady = false;

let speakerProfiles = [];
const sessionSpeakers = new Map();
const sessionProfileAssignments = new Map();
const speakerSignatureSamples = new Map();
const dismissedSpeakers = new Set();
const promptedSpeakers = new Set();

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
      },
    });

    video.srcObject = stream;
    errorMessage.hidden = true;
    startHandTracking();
  } catch {
    errorMessage.hidden = false;
  }
}

async function startDeepgramCaptions() {
  if (
    !navigator.mediaDevices?.getUserMedia ||
    !window.MediaRecorder ||
    !window.WebSocket
  ) {
    showCaptionError("Live microphone streaming is not available.");
    return;
  }

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    startVoiceFingerprinting(micStream);
    captionSocket = new WebSocket(DEEPGRAM_PROXY_URL);

    captionSocket.onopen = () => {
      recorder = createMediaRecorder(micStream);
      recorder.ondataavailable = (event) => {
        if (
          event.data.size > 0 &&
          captionSocket?.readyState === WebSocket.OPEN
        ) {
          captionSocket.send(event.data);
        }
      };
      recorder.start(CHUNK_MS);
    };

    captionSocket.onmessage = (event) => {
      const message = parseJson(event.data);
      if (!message) return;

      if (message.type === "Error") {
        showCaptionError(message.error || "Deepgram captioning failed.");
        return;
      }

      if (message.type !== "Results") return;

      const alternative = message.channel?.alternatives?.[0];
      const text = normalizeTranscript(alternative?.transcript || "");
      if (!text || text === lastTranscript) return;

      const speakerId = extractSpeakerId(alternative);
      const speakerLabel = getSpeakerLabel(speakerId);
      if (speakerId !== null) {
        collectSpeakerSignature(speakerId);
        maybePromptForSpeaker(speakerId);
      }

      lastTranscript = text;
      captionOverlay.hidden = false;
      captionStatus.textContent =
        message.is_final || message.speech_final
          ? `${speakerLabel} - Deepgram captions`
          : `${speakerLabel} - Listening`;
      captionText.textContent = text;
      confidenceBar.style.width = `${Math.round((alternative.confidence || 0.82) * 100)}%`;
    };

    captionSocket.onerror = () => {
      showCaptionError("Start deepgram_server before launching captions.");
    };

    captionSocket.onclose = () => {
      if (recorder?.state === "recording") {
        showCaptionError(
          "Deepgram captions disconnected. Check the server terminal.",
        );
      }
    };
  } catch {
    showCaptionError("Microphone permission was denied.");
  }
}

function showCaptionError(message) {
  captionOverlay.hidden = false;
  captionStatus.textContent = "Caption setup needed";
  captionText.textContent = message;
  confidenceBar.style.width = "0%";
}

function startHandTracking() {
  if (!window.Hands) {
    console.warn("Hand tracking unavailable (MediaPipe Hands not loaded).");
    handStatus.textContent = "Hand tracking: not loaded";
    return;
  }

  if (handTracker) return;
  handSendFailures = 0;
  handFrameBusy = false;
  handFrameIntervalMs = 67;
  lastHandErrorText = "";
  handModelReady = false;
  handStatus.textContent = "Hand tracking: loading model...";

  const hands = new window.Hands({
    locateFile: (file) => `${MEDIAPIPE_HANDS_BASE_URL}${file}`,
  });

  hands.setOptions({
    maxNumHands: 1,
    modelComplexity: 0,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });

  hands.onResults((results) => {
    const landmarks = results?.multiHandLandmarks?.[0];
    if (!landmarks) {
      handCursor.hidden = true;
      pinchDown = false;
      lastCursorPoint = null;
      handStatus.textContent = "Hand tracking: no hand";
      return;
    }

    const indexTip = landmarks[8];
    const indexPip = landmarks[6];
    const indexMcp = landmarks[5];
    const indexDip = landmarks[7];
    const thumbTip = landmarks[4];

    // We mirror the video in CSS, so mirror X here too.
    const xNorm = 1 - indexTip.x;
    const yNorm = indexTip.y;

    const fingerExtended = isIndexFingerExtended(
      indexMcp,
      indexPip,
      indexDip,
      indexTip,
    );
    if (!fingerExtended) {
      handCursor.hidden = true;
      pinchDown = false;
      lastCursorPoint = null;
      handStatus.textContent = "Hand tracking: hand detected (raise index)";
      return;
    }

    const rect = video.getBoundingClientRect();
    const x = rect.left + clamp01(xNorm) * rect.width;
    const y = rect.top + clamp01(yNorm) * rect.height;

    handCursor.hidden = false;
    handCursor.style.left = `${x}px`;
    handCursor.style.top = `${y}px`;
    lastCursorPoint = { x, y };
    handStatus.textContent = "Hand tracking: index up";

    const pinchDistance = Math.hypot(
      indexTip.x - thumbTip.x,
      indexTip.y - thumbTip.y,
    );
    const pinchNow = pinchDistance < 0.045;
    const releaseNow = pinchDistance > 0.06;

    if (!pinchDown && pinchNow) {
      pinchDown = true;
      handCursor.classList.add("clicking");
      handStatus.textContent = "Hand tracking: pinch click";
      clickAtPoint(x, y);
    } else if (pinchDown && releaseNow) {
      pinchDown = false;
      handCursor.classList.remove("clicking");
    }
  });

  handTracker = hands;

  const initializePromise =
    typeof hands.initialize === "function"
      ? hands.initialize()
      : Promise.resolve();

  initializePromise
    .then(() => {
      handModelReady = true;
      handStatus.textContent = "Hand tracking: ready";
    })
    .catch((error) => {
      const errorText = String(
        error?.message || error || "unknown error",
      ).slice(0, 140);
      handStatus.textContent = `Hand tracking unavailable: ${errorText}`;
      console.error("Hand tracking model initialization failed:", error);
      handTracker = null;
      handFrameBusy = false;
      handModelReady = false;
    });

  const tick = async () => {
    if (!handTracker) return;
    const now = performance.now();
    const shouldSendFrame =
      handModelReady &&
      !document.hidden &&
      video.readyState >= 2 &&
      video.videoWidth > 0 &&
      video.videoHeight > 0 &&
      !video.paused &&
      !video.ended &&
      !handFrameBusy &&
      now - lastHandFrameAt >= handFrameIntervalMs;

    if (shouldSendFrame) {
      handFrameBusy = true;
      lastHandFrameAt = now;
      try {
        await handTracker.send({ image: video });
        handSendFailures = 0;
        handFrameIntervalMs = Math.max(50, handFrameIntervalMs - 2);
        if (lastHandErrorText) {
          lastHandErrorText = "";
          handStatus.textContent = "Hand tracking: index up";
        }
      } catch (error) {
        handSendFailures += 1;
        handFrameIntervalMs = Math.min(250, handFrameIntervalMs + 12);
        const errorText = String(
          error?.message || error || "unknown error",
        ).slice(0, 140);
        lastHandErrorText = errorText;

        if (handSendFailures === 15) {
          handStatus.textContent = `Hand tracking failed: ${errorText}`;
          console.warn("Hand tracking send failed:", error);
        }

        if (handSendFailures >= 30) {
          const elapsedSinceRestart = Date.now() - lastHandRestartAt;
          if (!handRestartInProgress && elapsedSinceRestart > 5000) {
            handRestartInProgress = true;
            lastHandRestartAt = Date.now();
            handStatus.textContent = "Hand tracking: restarting model...";
            void restartHandTracking();
          }
        }
      } finally {
        handFrameBusy = false;
      }
    }
    window.requestAnimationFrame(tick);
  };

  window.requestAnimationFrame(tick);
}

async function restartHandTracking() {
  const previousTracker = handTracker;
  handTracker = null;
  handFrameBusy = false;
  handModelReady = false;

  try {
    await previousTracker?.close?.();
  } catch {
    // Ignore close errors and continue with a fresh tracker.
  }

  window.setTimeout(() => {
    handRestartInProgress = false;
    startHandTracking();
  }, 400);
}

function clickAtPoint(x, y) {
  const target = document.elementFromPoint(x, y);
  if (!target) return;

  // Avoid clicking the cursor itself.
  if (target === handCursor) return;

  const options = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    view: window,
  };

  target.dispatchEvent(new MouseEvent("mousemove", options));
  target.dispatchEvent(new MouseEvent("mousedown", options));
  target.dispatchEvent(new MouseEvent("mouseup", options));
  target.dispatchEvent(new MouseEvent("click", options));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function isIndexFingerExtended(indexMcp, indexPip, indexDip, indexTip) {
  // Use 3D joint angles so "finger up" works even when the hand is rotated
  // toward the camera (where simple y-comparisons fail).
  const pipAngle = jointAngle(indexMcp, indexPip, indexDip);
  const dipAngle = jointAngle(indexPip, indexDip, indexTip);

  if (Number.isFinite(pipAngle) && Number.isFinite(dipAngle)) {
    if (pipAngle > 150 && dipAngle > 150) return true;
  }

  // Fallback: length-based check.
  const mcpToTip = distance3(indexMcp, indexTip);
  const mcpToPip = distance3(indexMcp, indexPip);
  if (mcpToTip > mcpToPip + 0.045) return true;

  // Final fallback: basic vertical ordering (works when hand is upright).
  return indexTip.y < indexPip.y - 0.01;
}

function jointAngle(a, b, c) {
  const ab = { x: a.x - b.x, y: a.y - b.y, z: (a.z ?? 0) - (b.z ?? 0) };
  const cb = { x: c.x - b.x, y: c.y - b.y, z: (c.z ?? 0) - (b.z ?? 0) };

  const abLen = Math.hypot(ab.x, ab.y, ab.z);
  const cbLen = Math.hypot(cb.x, cb.y, cb.z);
  if (!abLen || !cbLen) return NaN;

  const dot = ab.x * cb.x + ab.y * cb.y + ab.z * cb.z;
  const cos = dot / (abLen * cbLen);
  const clamped = Math.max(-1, Math.min(1, cos));
  return (Math.acos(clamped) * 180) / Math.PI;
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
}

function parseJson(data) {
  if (typeof data !== "string") return null;

  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function chooseMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function createMediaRecorder(stream) {
  const mimeType = chooseMimeType();
  return mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);
}

function normalizeTranscript(text) {
  return text.replace(/\s+/g, " ").replace(/\bi\b/g, "I").trim();
}

function extractSpeakerId(alternative) {
  const speaker = alternative?.words?.find(
    (word) => word.speaker !== undefined,
  )?.speaker;
  return typeof speaker === "number" ? `speaker-${speaker}` : null;
}

function getSpeakerLabel(speakerId) {
  if (speakerId === null) return "Unknown speaker";

  const profileId = sessionSpeakers.get(speakerId);
  const profile = speakerProfiles.find((item) => item.id === profileId);
  if (profile) return profile.label;

  return speakerId.replace("speaker-", "Speaker ");
}

function maybePromptForSpeaker(speakerId) {
  if (
    sessionSpeakers.has(speakerId) ||
    dismissedSpeakers.has(speakerId) ||
    promptedSpeakers.has(speakerId)
  ) {
    return;
  }
  if (pendingSpeakerId && pendingSpeakerId !== speakerId) return;

  const match = findVoiceMatch(speakerId);
  pendingSpeakerId = speakerId;
  pendingMatchProfileId = match?.id ?? null;
  speakerPrompt.hidden = false;
  speakerPromptButton.hidden = false;
  speakerPromptForm.hidden = true;
  speakerPromptName.textContent = match
    ? `Sounds like ${match.label} - tap to confirm`
    : `${getSpeakerLabel(speakerId)} - tap to name`;
}

async function createSpeakerProfile(label) {
  if (!pendingSpeakerId) return;

  const now = new Date().toISOString();
  const profile = {
    id: `profile-${Date.now()}`,
    label,
    source: pendingSpeakerId,
    signature: averageSpeakerSignature(pendingSpeakerId),
    createdAt: now,
    lastSeenAt: now,
  };

  speakerProfiles = upsertProfile(speakerProfiles, profile);
  sessionSpeakers.set(pendingSpeakerId, profile.id);
  sessionProfileAssignments.set(profile.id, pendingSpeakerId);
  promptedSpeakers.add(pendingSpeakerId);
  await saveSpeakerProfile(profile);
  hideSpeakerPrompt();
}

async function confirmMatchedSpeaker() {
  if (!pendingSpeakerId || !pendingMatchProfileId) return;

  const profile = speakerProfiles.find(
    (item) => item.id === pendingMatchProfileId,
  );
  if (!profile) return;

  const assignedSpeakerId = sessionProfileAssignments.get(profile.id);
  if (assignedSpeakerId && assignedSpeakerId !== pendingSpeakerId) {
    pendingMatchProfileId = null;
    openRenameForm();
    return;
  }

  const updatedProfile = {
    ...profile,
    source: pendingSpeakerId,
    signature: blendSignatures(
      profile.signature,
      averageSpeakerSignature(pendingSpeakerId),
    ),
    lastSeenAt: new Date().toISOString(),
  };

  speakerProfiles = upsertProfile(speakerProfiles, updatedProfile);
  sessionSpeakers.set(pendingSpeakerId, updatedProfile.id);
  sessionProfileAssignments.set(updatedProfile.id, pendingSpeakerId);
  promptedSpeakers.add(pendingSpeakerId);
  await saveSpeakerProfile(updatedProfile);
  hideSpeakerPrompt();
}

function hideSpeakerPrompt() {
  pendingSpeakerId = null;
  pendingMatchProfileId = null;
  speakerPrompt.hidden = true;
  speakerPromptButton.hidden = false;
  speakerPromptForm.hidden = true;
  speakerNameInput.value = "";
}

function openRenameForm() {
  speakerPromptButton.hidden = true;
  speakerPromptForm.hidden = false;
  speakerNameInput.value = pendingSpeakerId
    ? getSpeakerLabel(pendingSpeakerId)
    : "";
  speakerNameInput.focus();
  speakerNameInput.select();
}

async function refreshSpeakerProfiles() {
  try {
    const response = await fetch(SPEAKER_PROFILES_URL);
    const payload = await response.json();
    speakerProfiles = Array.isArray(payload.profiles) ? payload.profiles : [];
  } catch {
    console.warn("Could not load speaker profiles.");
  }
}

async function saveSpeakerProfile(profile) {
  try {
    const response = await fetch(SPEAKER_PROFILES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(profile),
    });
    const payload = await response.json();
    speakerProfiles = Array.isArray(payload.profiles)
      ? payload.profiles
      : speakerProfiles;
  } catch {
    console.warn("Could not save speaker profile.");
  }
}

function upsertProfile(profiles, profile) {
  const existingIndex = profiles.findIndex((item) => item.id === profile.id);
  if (existingIndex === -1) return [...profiles, profile];

  return profiles.map((item, index) =>
    index === existingIndex ? profile : item,
  );
}

function startVoiceFingerprinting(stream) {
  try {
    voiceAudioContext = new AudioContext();
    voiceAnalyser = voiceAudioContext.createAnalyser();
    voiceAnalyser.fftSize = 2048;
    voiceAnalyser.smoothingTimeConstant = 0.72;

    const source = voiceAudioContext.createMediaStreamSource(stream);
    source.connect(voiceAnalyser);

    const timeData = new Uint8Array(voiceAnalyser.fftSize);
    const frequencyData = new Uint8Array(voiceAnalyser.frequencyBinCount);

    voiceInterval = window.setInterval(() => {
      currentVoiceSignature = readVoiceSignature(
        voiceAnalyser,
        timeData,
        frequencyData,
      );
    }, 120);
  } catch {
    console.warn("Voice fingerprinting could not start.");
  }
}

function readVoiceSignature(analyser, timeData, frequencyData) {
  analyser.getByteTimeDomainData(timeData);
  analyser.getByteFrequencyData(frequencyData);

  let rmsSum = 0;
  let zcr = 0;
  for (let index = 0; index < timeData.length; index += 1) {
    const value = (timeData[index] - 128) / 128;
    rmsSum += value * value;
    if (index > 0) {
      const previous = timeData[index - 1] - 128;
      const current = timeData[index] - 128;
      if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) {
        zcr += 1;
      }
    }
  }

  let low = 0;
  let mid = 0;
  let high = 0;
  let weighted = 0;
  let total = 0;

  for (let index = 0; index < frequencyData.length; index += 1) {
    const value = frequencyData[index] / 255;
    const position = index / frequencyData.length;
    total += value;
    weighted += value * position;

    if (position < 0.18) low += value;
    else if (position < 0.46) mid += value;
    else high += value;
  }

  const energy = low + mid + high || 1;
  return [
    Math.sqrt(rmsSum / timeData.length),
    zcr / timeData.length,
    low / energy,
    mid / energy,
    high / energy,
    total > 0 ? weighted / total : 0,
  ].map((value) => Number(value.toFixed(6)));
}

function collectSpeakerSignature(speakerId) {
  if (!currentVoiceSignature || currentVoiceSignature[0] < 0.012) return;

  const samples = speakerSignatureSamples.get(speakerId) ?? [];
  samples.push(currentVoiceSignature);
  speakerSignatureSamples.set(speakerId, samples.slice(-30));
}

function averageSpeakerSignature(speakerId) {
  const samples = speakerSignatureSamples.get(speakerId) ?? [];
  if (samples.length === 0) return currentVoiceSignature ?? [];

  return averageSignatures(samples);
}

function averageSignatures(signatures) {
  const length = signatures[0]?.length ?? 0;
  if (length === 0) return [];

  return Array.from({ length }, (_, index) => {
    const sum = signatures.reduce(
      (total, signature) => total + (signature[index] ?? 0),
      0,
    );
    return Number((sum / signatures.length).toFixed(6));
  });
}

function findVoiceMatch(speakerId) {
  const signature = averageSpeakerSignature(speakerId);
  if (signature.length === 0) return null;

  const samples = speakerSignatureSamples.get(speakerId) ?? [];
  if (samples.length < 10) return null;

  let bestMatch = null;
  let bestDistance = Infinity;
  let secondBestDistance = Infinity;

  for (const profile of speakerProfiles) {
    if (
      !Array.isArray(profile.signature) ||
      profile.signature.length !== signature.length
    ) {
      continue;
    }

    const assignedSpeakerId = sessionProfileAssignments.get(profile.id);
    if (assignedSpeakerId && assignedSpeakerId !== speakerId) {
      continue;
    }

    const distance = signatureDistance(signature, profile.signature);
    if (distance < bestDistance) {
      secondBestDistance = bestDistance;
      bestDistance = distance;
      bestMatch = profile;
    } else if (distance < secondBestDistance) {
      secondBestDistance = distance;
    }
  }

  const hasClearMargin =
    secondBestDistance === Infinity ||
    secondBestDistance - bestDistance > 0.035;

  return bestDistance < 0.075 && hasClearMargin ? bestMatch : null;
}

function signatureDistance(left, right) {
  const weights = [2.1, 1.2, 1.4, 1.4, 1.4, 1.8];
  const sum = left.reduce((total, value, index) => {
    const delta = value - (right[index] ?? 0);
    return total + delta * delta * (weights[index] ?? 1);
  }, 0);

  return Math.sqrt(sum / left.length);
}

function blendSignatures(existing, next) {
  if (!Array.isArray(existing) || existing.length === 0) return next;
  if (!Array.isArray(next) || next.length === 0) return existing;

  return existing.map((value, index) =>
    Number((value * 0.75 + (next[index] ?? value) * 0.25).toFixed(6)),
  );
}

closeButton.addEventListener("click", () => {
  window.lumenWindow?.close();
});

speakerPromptButton.addEventListener("click", () => {
  if (pendingMatchProfileId) {
    void confirmMatchedSpeaker();
    return;
  }

  openRenameForm();
});

speakerPromptForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const label = speakerNameInput.value.trim();
  void createSpeakerProfile(label || "New speaker");
});

speakerLaterButton.addEventListener("click", () => {
  if (pendingSpeakerId) {
    dismissedSpeakers.add(pendingSpeakerId);
  }
  hideSpeakerPrompt();
});

window.addEventListener("beforeunload", () => {
  if (recorder?.state !== "inactive") recorder?.stop();
  captionSocket?.close();
  micStream?.getTracks().forEach((track) => track.stop());
  if (voiceInterval !== null) window.clearInterval(voiceInterval);
  void voiceAudioContext?.close();
  handTracker = null;
  handFrameBusy = false;
  handRestartInProgress = false;
  lastHandErrorText = "";
  handModelReady = false;
});

startCamera();
void refreshSpeakerProfiles();
window.setInterval(refreshSpeakerProfiles, 2500);
startDeepgramCaptions();
