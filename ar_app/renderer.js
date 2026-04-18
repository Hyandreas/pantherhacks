const DEEPGRAM_PROXY_URL = "ws://127.0.0.1:8788/captions";
const SPEAKER_PROFILES_URL = "http://127.0.0.1:8788/speaker-profiles";
const TRANSLATE_URL = "http://127.0.0.1:8788/translate";
const MEDIAPIPE_HANDS_BASE_URL = new URL(
  "./node_modules/@mediapipe/hands/",
  window.location.href,
).toString();
const CHUNK_MS = 250;
const DWELL_CLICK_MS = 2000;
const DWELL_COOLDOWN_MS = 900;

const video = document.querySelector("#cameraFeed");
const errorMessage = document.querySelector("#cameraError");
const closeButton = document.querySelector("#closeButton");
const translateButton = document.querySelector("#translateButton");
const translatePanel = document.querySelector("#translatePanel");
const translatePanelClose = document.querySelector("#translatePanelClose");
const spokenLanguageButton = document.querySelector("#spokenLanguageButton");
const spokenLanguageList = document.querySelector("#spokenLanguageList");
const captionLanguageButton = document.querySelector("#captionLanguageButton");
const captionLanguageList = document.querySelector("#captionLanguageList");
const captionOverlay = document.querySelector("#captionOverlay");
const captionStatus = document.querySelector("#captionStatus");
const captionText = document.querySelector("#captionText");
const whoIsThisButton = document.querySelector("#whoIsThisButton");
const confidenceBar = document.querySelector("#confidenceBar span");
const speakerPrompt = document.querySelector("#speakerPrompt");
const speakerPromptButton = document.querySelector("#speakerPromptButton");
const speakerPromptName = document.querySelector("#speakerPromptName");
const speakerPromptForm = document.querySelector("#speakerPromptForm");
const speakerNameInput = document.querySelector("#speakerNameInput");
const speakerLaterButton = document.querySelector("#speakerLaterButton");
const speakerInfoPanel = document.querySelector("#speakerInfoPanel");
const speakerInfoClose = document.querySelector("#speakerInfoClose");
const speakerInfoName = document.querySelector("#speakerInfoName");
const speakerInfoRelation = document.querySelector("#speakerInfoRelation");
const speakerInfoDescription = document.querySelector("#speakerInfoDescription");
const speakerInfoForm = document.querySelector("#speakerInfoForm");
const speakerProfilePickerButton = document.querySelector("#speakerProfilePickerButton");
const speakerProfilePickerList = document.querySelector("#speakerProfilePickerList");
const speakerInfoNameInput = document.querySelector("#speakerInfoNameInput");
const speakerInfoRelationInput = document.querySelector("#speakerInfoRelationInput");
const speakerInfoDescriptionInput = document.querySelector("#speakerInfoDescriptionInput");
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
let currentSpeakerId = null;
let infoPanelSpeakerId = null;
let selectedSpeakerProfileId = "";
let captionSequence = 0;
let pendingSpeakerId = null;
let pendingMatchProfileId = null;
let handTracker = null;
let pinchDown = false;
let lastCursorPoint = null;
let dwellTarget = null;
let dwellStartedAt = 0;
let dwellCooldownUntil = 0;
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

const languages = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "zh-CN", label: "Chinese" },
  { code: "hi", label: "Hindi" },
  { code: "ar", label: "Arabic" },
  { code: "pt", label: "Portuguese" },
  { code: "ko", label: "Korean" },
  { code: "ja", label: "Japanese" },
];
let spokenLanguageCode = "en";
let captionLanguageCode = "en";
const translationCache = new Map();

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
      currentSpeakerId = speakerId;
      if (speakerId !== null) {
        ensureProfileForSpeaker(speakerId);
        collectSpeakerSignature(speakerId);
        maybePromptForSpeaker(speakerId);
      }
      const speakerLabel = getSpeakerLabel(speakerId);

      lastTranscript = text;
      captionOverlay.hidden = false;
      const nextCaptionSequence = captionSequence + 1;
      captionSequence = nextCaptionSequence;
      captionStatus.textContent =
        message.is_final || message.speech_final
          ? `${speakerLabel} - Deepgram captions`
          : `${speakerLabel} - Listening`;
      showCaptionText(text, speakerLabel, nextCaptionSequence);
      whoIsThisButton.hidden = speakerId === null;
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

async function showCaptionText(text, speakerLabel, sequence) {
  if (spokenLanguageCode === captionLanguageCode) {
    captionText.textContent = text;
    return;
  }

  const sourceLanguage = findLanguage(spokenLanguageCode);
  const targetLanguage = findLanguage(captionLanguageCode);
  captionText.textContent = text;
  captionStatus.textContent = `${speakerLabel} - translating ${sourceLanguage.short} -> ${targetLanguage.short}`;

  const translatedText = await translateCaption(text);
  if (sequence !== captionSequence) return;

  if (translatedText) {
    captionText.textContent = translatedText;
    captionStatus.textContent = `${speakerLabel} - translated ${sourceLanguage.short} -> ${targetLanguage.short}`;
  } else {
    captionStatus.textContent = `${speakerLabel} - translation unavailable`;
  }
}

async function translateCaption(text) {
  const cacheKey = `${spokenLanguageCode}:${captionLanguageCode}:${text}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  try {
    const response = await fetch(TRANSLATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        source: spokenLanguageCode,
        target: captionLanguageCode,
      }),
    });
    const payload = await response.json();
    const translatedText =
      response.ok && payload?.ok
        ? String(payload.translatedText ?? "").trim()
        : "";
    if (translatedText) {
      translationCache.set(cacheKey, translatedText);
    }
    return translatedText;
  } catch {
    return "";
  }
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
      resetDwellClick();
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
      resetDwellClick();
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
      resetDwellClick();
    } else if (pinchDown && releaseNow) {
      pinchDown = false;
      handCursor.classList.remove("clicking");
    } else if (!pinchDown) {
      updateDwellClick(x, y);
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
  const target = getInteractiveTargetAtPoint(x, y);
  if (!target) return;

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

function updateDwellClick(x, y) {
  const now = performance.now();
  const target = getInteractiveTargetAtPoint(x, y);

  if (!target || now < dwellCooldownUntil) {
    resetDwellClick();
    return;
  }

  if (target !== dwellTarget) {
    dwellTarget = target;
    dwellStartedAt = now;
    handCursor.style.setProperty("--dwell-progress", "0deg");
    handCursor.classList.add("dwelling");
    handStatus.textContent = "Hand tracking: hold to click";
    return;
  }

  const elapsed = now - dwellStartedAt;
  const progress = Math.min(1, elapsed / DWELL_CLICK_MS);
  handCursor.style.setProperty("--dwell-progress", `${Math.round(progress * 360)}deg`);

  if (progress >= 1) {
    handCursor.classList.add("clicking");
    handStatus.textContent = "Hand tracking: hold click";
    clickAtPoint(x, y);
    dwellCooldownUntil = now + DWELL_COOLDOWN_MS;
    resetDwellClick();
    window.setTimeout(() => handCursor.classList.remove("clicking"), 180);
  }
}

function resetDwellClick() {
  dwellTarget = null;
  dwellStartedAt = 0;
  handCursor.classList.remove("dwelling");
  handCursor.style.setProperty("--dwell-progress", "0deg");
}

function getInteractiveTargetAtPoint(x, y) {
  const target = document.elementFromPoint(x, y);
  if (!target || target === handCursor) return null;

  return target.closest(
    "button, input, textarea, select, a, label, [role='button'], [tabindex]:not([tabindex='-1'])",
  );
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
  const speakerCounts = new Map();
  for (const word of alternative?.words ?? []) {
    if (typeof word.speaker !== "number") continue;
    speakerCounts.set(word.speaker, (speakerCounts.get(word.speaker) ?? 0) + 1);
  }

  let speaker = null;
  let maxCount = 0;
  for (const [candidate, count] of speakerCounts) {
    if (count > maxCount) {
      speaker = candidate;
      maxCount = count;
    }
  }

  return typeof speaker === "number" ? `speaker-${speaker}` : null;
}

function getSpeakerLabel(speakerId) {
  if (speakerId === null) return "Unknown speaker";

  const profile = getProfileForSpeaker(speakerId);
  if (profile) return profile.label;

  return defaultSpeakerLabel(speakerId);
}

function defaultSpeakerLabel(speakerId) {
  const speakerIndex = speakerId.match(/^speaker-(\d+)$/)?.[1];
  return speakerIndex === undefined
    ? speakerId.replace(/[-_]/g, " ")
    : `Speaker ${Number(speakerIndex) + 1}`;
}

function getProfileForSpeaker(speakerId) {
  if (speakerId === null) return null;

  const profileId = sessionSpeakers.get(speakerId);
  const profile = speakerProfiles.find((item) => item.id === profileId);
  return profile ?? speakerProfiles.find((item) => hasProfileSource(item, speakerId)) ?? null;
}

function maybePromptForSpeaker(speakerId) {
  if (
    dismissedSpeakers.has(speakerId) ||
    promptedSpeakers.has(speakerId)
  ) {
    return;
  }
  if (pendingSpeakerId && pendingSpeakerId !== speakerId) return;

  pendingSpeakerId = speakerId;
  pendingMatchProfileId = null;
  speakerPrompt.hidden = false;
  speakerPromptButton.hidden = false;
  speakerPromptForm.hidden = true;
  speakerPromptName.textContent = `Who's this? ${getSpeakerLabel(speakerId)}`;
}

function ensureProfileForSpeaker(speakerId) {
  const existingProfile = getProfileForSpeaker(speakerId);
  if (existingProfile) {
    sessionSpeakers.set(speakerId, existingProfile.id);
    sessionProfileAssignments.set(existingProfile.id, speakerId);
    return existingProfile;
  }

  const now = new Date().toISOString();
  const profile = {
    id: `profile-${speakerId}-${Date.now()}`,
    label: defaultSpeakerLabel(speakerId),
    relation: "",
    description: "",
    source: speakerId,
    sources: [speakerId],
    signature: averageSpeakerSignature(speakerId),
    createdAt: now,
    lastSeenAt: now,
  };

  speakerProfiles = upsertProfile(speakerProfiles, profile);
  sessionSpeakers.set(speakerId, profile.id);
  sessionProfileAssignments.set(profile.id, speakerId);
  void saveSpeakerProfile(profile);
  return profile;
}

async function createSpeakerProfile(label, relation = "", description = "") {
  if (!pendingSpeakerId) return;

  const now = new Date().toISOString();
  const existingProfile = getProfileForSpeaker(pendingSpeakerId);
  const profile = {
    ...existingProfile,
    id: existingProfile?.id ?? `profile-${Date.now()}`,
    label,
    relation,
    description,
    source: existingProfile?.source || pendingSpeakerId,
    sources: addProfileSource(existingProfile?.sources, pendingSpeakerId),
    signature: averageSpeakerSignature(pendingSpeakerId),
    createdAt: existingProfile?.createdAt ?? now,
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
    source: profile.source || pendingSpeakerId,
    sources: addProfileSource(profile.sources, pendingSpeakerId),
    relation: profile.relation ?? "",
    description: profile.description ?? "",
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

function openSpeakerInfoPanel(speakerId = currentSpeakerId) {
  if (speakerId === null) return;

  infoPanelSpeakerId = speakerId;
  const assignedProfile = getProfileForSpeaker(speakerId);
  const suggestedProfile =
    pendingSpeakerId === speakerId && pendingMatchProfileId
      ? speakerProfiles.find((item) => item.id === pendingMatchProfileId) ?? null
      : null;
  const profile = assignedProfile ?? suggestedProfile;
  const fallbackName = defaultSpeakerLabel(speakerId);

  speakerInfoName.textContent = profile?.label ?? fallbackName;
  speakerInfoRelation.textContent = profile?.relation || "Not set";
  speakerInfoDescription.textContent =
    profile?.description || "No description yet.";
  renderSpeakerProfileOptions(profile?.id ?? "");
  speakerInfoNameInput.value = profile?.label ?? fallbackName;
  speakerInfoRelationInput.value = profile?.relation ?? "";
  speakerInfoDescriptionInput.value = profile?.description ?? "";
  speakerInfoPanel.hidden = false;
}

function closeSpeakerInfoPanel() {
  speakerInfoPanel.hidden = true;
  infoPanelSpeakerId = null;
  closeSpeakerProfilePicker();
}

async function saveSpeakerInfo(event) {
  event.preventDefault();
  if (infoPanelSpeakerId === null) return;

  const label =
    speakerInfoNameInput.value.trim() ||
    defaultSpeakerLabel(infoPanelSpeakerId);
  const relation = speakerInfoRelationInput.value.trim();
  const description = speakerInfoDescriptionInput.value.trim();
  let profile = selectedSpeakerProfileId
    ? speakerProfiles.find((item) => item.id === selectedSpeakerProfileId) ?? null
    : getProfileForSpeaker(infoPanelSpeakerId);

  if (!profile && pendingSpeakerId === infoPanelSpeakerId && pendingMatchProfileId) {
    profile = speakerProfiles.find((item) => item.id === pendingMatchProfileId) ?? null;
  }

  if (profile) {
    const updatedProfile = {
      ...profile,
      label,
      relation,
      description,
      source: profile.source || infoPanelSpeakerId,
      sources: addProfileSource(profile.sources, infoPanelSpeakerId),
      signature: blendSignatures(
        profile.signature,
        averageSpeakerSignature(infoPanelSpeakerId),
      ),
      lastSeenAt: new Date().toISOString(),
    };
    speakerProfiles = upsertProfile(speakerProfiles, updatedProfile);
    sessionSpeakers.set(infoPanelSpeakerId, updatedProfile.id);
    sessionProfileAssignments.set(updatedProfile.id, infoPanelSpeakerId);
    promptedSpeakers.add(infoPanelSpeakerId);
    await saveSpeakerProfile(updatedProfile);
  } else {
    pendingSpeakerId = infoPanelSpeakerId;
    await createSpeakerProfile(label, relation, description);
  }

  pendingSpeakerId = null;
  pendingMatchProfileId = null;
  speakerInfoName.textContent = label;
  speakerInfoRelation.textContent = relation || "Not set";
  speakerInfoDescription.textContent = description || "No description yet.";
  hideSpeakerPrompt();
}

async function refreshSpeakerProfiles() {
  try {
    const response = await fetch(SPEAKER_PROFILES_URL);
    const payload = await response.json();
    speakerProfiles = Array.isArray(payload.profiles)
      ? normalizeSpeakerProfiles(payload.profiles)
      : [];
    if (!speakerInfoPanel.hidden) {
      renderSpeakerProfileOptions(selectedSpeakerProfileId);
    }
  } catch {
    console.warn("Could not load speaker profiles.");
  }
}

function renderSpeakerProfileOptions(selectedProfileId = "") {
  selectedSpeakerProfileId = selectedProfileId;
  speakerProfilePickerList.replaceChildren();

  const createButton = document.createElement("button");
  createButton.type = "button";
  createButton.className = "speaker-profile-picker-option";
  createButton.dataset.profileId = "";
  createButton.textContent = "Create new profile";
  speakerProfilePickerList.append(createButton);

  for (const profile of speakerProfiles) {
    const label = profile.relation
      ? `${profile.label || "Unnamed profile"} - ${profile.relation}`
      : profile.label || "Unnamed profile";
    const option = document.createElement("button");
    option.type = "button";
    option.className = "speaker-profile-picker-option";
    option.dataset.profileId = profile.id;
    option.textContent = label;
    speakerProfilePickerList.append(option);
  }

  updateSpeakerProfilePickerButton();
}

function toggleSpeakerProfilePicker() {
  const open = speakerProfilePickerList.hidden;
  speakerProfilePickerList.hidden = !open;
  speakerProfilePickerButton.setAttribute("aria-expanded", String(open));
}

function closeSpeakerProfilePicker() {
  speakerProfilePickerList.hidden = true;
  speakerProfilePickerButton.setAttribute("aria-expanded", "false");
}

function selectSpeakerProfile(profileId) {
  selectedSpeakerProfileId = profileId;
  updateSpeakerProfilePickerButton();
  closeSpeakerProfilePicker();

  if (profileId) {
    fillSpeakerInfoFromProfile(profileId);
  }
}

function updateSpeakerProfilePickerButton() {
  const selectedProfile = speakerProfiles.find(
    (profile) => profile.id === selectedSpeakerProfileId,
  );
  if (!selectedProfile) {
    speakerProfilePickerButton.textContent = "Create new profile";
    return;
  }

  speakerProfilePickerButton.textContent = selectedProfile.relation
    ? `${selectedProfile.label || "Unnamed profile"} - ${selectedProfile.relation}`
    : selectedProfile.label || "Unnamed profile";
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
      ? normalizeSpeakerProfiles(payload.profiles)
      : speakerProfiles;
  } catch {
    console.warn("Could not save speaker profile.");
  }
}

function normalizeSpeakerProfiles(profiles) {
  return profiles.map((profile) => ({
    ...profile,
    label: profile.label || "",
    relation: profile.relation || "",
    description: profile.description || "",
    source: profile.source || "",
    sources: normalizeProfileSources(profile),
    signature: Array.isArray(profile.signature) ? profile.signature : [],
  }));
}

function normalizeProfileSources(profile) {
  const sources = Array.isArray(profile.sources) ? profile.sources : [];
  return Array.from(new Set([...sources, profile.source].filter(Boolean)));
}

function addProfileSource(sources, source) {
  return Array.from(new Set([...(Array.isArray(sources) ? sources : []), source].filter(Boolean)));
}

function hasProfileSource(profile, source) {
  return normalizeProfileSources(profile).includes(source);
}

function fillSpeakerInfoFromProfile(profileId) {
  const profile = speakerProfiles.find((item) => item.id === profileId);
  if (!profile || infoPanelSpeakerId === null) return;

  const fallbackName = defaultSpeakerLabel(infoPanelSpeakerId);
  speakerInfoName.textContent = profile.label || fallbackName;
  speakerInfoRelation.textContent = profile.relation || "Not set";
  speakerInfoDescription.textContent = profile.description || "No description yet.";
  speakerInfoNameInput.value = profile.label || fallbackName;
  speakerInfoRelationInput.value = profile.relation || "";
  speakerInfoDescriptionInput.value = profile.description || "";
}

function renderLanguageOptions() {
  renderLanguageList(spokenLanguageList, "spoken");
  renderLanguageList(captionLanguageList, "caption");
  updateTranslateLabels();
}

function renderLanguageList(list, type) {
  list.replaceChildren();

  for (const language of languages) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "language-picker-option";
    option.dataset.languageType = type;
    option.dataset.languageCode = language.code;
    option.textContent = language.label;
    list.append(option);
  }
}

function toggleTranslatePanel() {
  const open = translatePanel.hidden;
  translatePanel.hidden = !open;
  translateButton.setAttribute("aria-expanded", String(open));
  if (open) {
    closeLanguageLists();
  }
}

function closeTranslatePanel() {
  translatePanel.hidden = true;
  translateButton.setAttribute("aria-expanded", "false");
  closeLanguageLists();
}

function toggleLanguageList(type) {
  const list = type === "spoken" ? spokenLanguageList : captionLanguageList;
  const button = type === "spoken" ? spokenLanguageButton : captionLanguageButton;
  const open = list.hidden;

  closeLanguageLists();
  list.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeLanguageLists() {
  spokenLanguageList.hidden = true;
  captionLanguageList.hidden = true;
  spokenLanguageButton.setAttribute("aria-expanded", "false");
  captionLanguageButton.setAttribute("aria-expanded", "false");
}

function selectLanguage(type, code) {
  if (type === "spoken") {
    spokenLanguageCode = code;
  } else {
    captionLanguageCode = code;
  }

  updateTranslateLabels();
  closeLanguageLists();
  lastTranscript = "";
}

function updateTranslateLabels() {
  const spokenLanguage = findLanguage(spokenLanguageCode);
  const captionLanguage = findLanguage(captionLanguageCode);
  spokenLanguageButton.textContent = spokenLanguage.label;
  captionLanguageButton.textContent = captionLanguage.label;
  translateButton.textContent = `${spokenLanguage.short} -> ${captionLanguage.short}`;
}

function findLanguage(code) {
  const language = languages.find((item) => item.code === code) ?? languages[0];
  return {
    ...language,
    short: language.code.toUpperCase(),
  };
}

function upsertProfile(profiles, profile) {
  const existingIndex = profiles.findIndex(
    (item) =>
      item.id === profile.id ||
      normalizeProfileSources(item).some((source) =>
        normalizeProfileSources(profile).includes(source),
      ),
  );
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

  return bestDistance < 0.045 && hasClearMargin ? bestMatch : null;
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

translateButton.addEventListener("click", toggleTranslatePanel);
translatePanelClose.addEventListener("click", closeTranslatePanel);
spokenLanguageButton.addEventListener("click", () => toggleLanguageList("spoken"));
captionLanguageButton.addEventListener("click", () => toggleLanguageList("caption"));
translatePanel.addEventListener("click", (event) => {
  const option = event.target.closest(".language-picker-option");
  if (!option) return;

  selectLanguage(option.dataset.languageType, option.dataset.languageCode);
});

speakerPromptButton.addEventListener("click", () => {
  openSpeakerInfoPanel(pendingSpeakerId);
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

whoIsThisButton.addEventListener("click", () => {
  openSpeakerInfoPanel(currentSpeakerId);
});

speakerInfoClose.addEventListener("click", closeSpeakerInfoPanel);
speakerInfoForm.addEventListener("submit", (event) => {
  void saveSpeakerInfo(event);
});
speakerProfilePickerButton.addEventListener("click", toggleSpeakerProfilePicker);
speakerProfilePickerList.addEventListener("click", (event) => {
  const option = event.target.closest(".speaker-profile-picker-option");
  if (option) {
    selectSpeakerProfile(option.dataset.profileId ?? "");
  }
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
renderLanguageOptions();
void refreshSpeakerProfiles();
window.setInterval(refreshSpeakerProfiles, 2500);
startDeepgramCaptions();
