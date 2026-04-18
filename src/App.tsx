import { useEffect, useMemo, useRef, useState } from "react";
import {
  BrowserSpeechAdapter,
  playScenario,
  simplifySentence,
  type DemoAdapterControls,
} from "./adapters";
import { scenarios } from "./scenarios";
import type {
  CaptionSegment,
  Scenario,
  ScenarioTranscriptEvent,
  SessionEvent,
  SessionMode,
  SoundAlert,
} from "./types";

const speechAdapter = new BrowserSpeechAdapter();
const MAX_CAPTIONS = 200;

const speakerPalette: Record<string, string> = {
  live_a: "#98ffd8",
  live_b: "#ffd18b",
  live_c: "#d6c2ff",
};

interface MissedMoment {
  id: string;
  timestamp: string;
  beforeCaptionId?: string;
  recoveryCaptionId?: string;
  status: "waiting" | "captured";
}

function sanitizeText(text: string): string {
  return text.slice(0, 500).replace(/[<>]/g, "");
}

function App() {
  const [sessionMode, setSessionMode] = useState<SessionMode>("bridge");
  const [selectedScenarioId, setSelectedScenarioId] = useState(scenarios[0].id);
  const [captions, setCaptions] = useState<CaptionSegment[]>([]);
  const [, setEvents] = useState<SessionEvent[]>([]);
  const [soundAlerts, setSoundAlerts] = useState<SoundAlert[]>([]);
  const [listening, setListening] = useState(false);
  const [plainLanguageEnabled, setPlainLanguageEnabled] = useState(true);
  const [focusEnabled, setFocusEnabled] = useState(false);
  const [showDemoOptions, setShowDemoOptions] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hearingPrompt, setHearingPrompt] = useState<string | null>(null);
  const [missedMoments, setMissedMoments] = useState<MissedMoment[]>([]);
  const [pendingMissedMomentId, setPendingMissedMomentId] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState(
    "Consent-first bridge mode is ready. Start live captions or run a scenario.",
  );
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [flashCritical, setFlashCritical] = useState(false);
  const [micLevel, setMicLevel] = useState(0);
  const demoControlsRef = useRef<DemoAdapterControls | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const volumeFrameRef = useRef<number | null>(null);
  const liveTranscriptCache = useRef<Record<string, string>>({});
  const pendingMissedMomentIdRef = useRef<string | null>(null);
  const pendingMissedBeforeCaptionIdRef = useRef<string | null>(null);
  const captionEndRef = useRef<HTMLDivElement>(null);

  const selectedScenario = useMemo(
    () => scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? scenarios[0],
    [selectedScenarioId],
  );

  const visibleCaptions = useMemo(
    () => (focusEnabled ? captions.filter((caption) => caption.isFocused) : captions),
    [captions, focusEnabled],
  );

  const rollingSummary = useMemo(() => {
    const recent = captions.slice(-3);
    if (recent.length === 0) {
      return "No conversation memory yet. Start a live session or load a demo scenario.";
    }
    return recent
      .map((caption) => `${caption.speakerLabel}: ${caption.plainLanguageText ?? caption.text}`)
      .join(" ");
  }, [captions]);

  const actionItems = useMemo(() => {
    return captions
      .reduce<string[]>((acc, caption) => acc.concat(caption.entities ?? []), [])
      .filter((entity, index, list) => list.indexOf(entity) === index)
      .slice(0, 5);
  }, [captions]);

  const latestCaption = visibleCaptions[visibleCaptions.length - 1] ?? null;
  const confidenceState = latestCaption ? confidenceLabel(latestCaption.confidence) : null;
  const pendingMissedMoment = missedMoments.find(
    (moment) => moment.id === pendingMissedMomentId,
  );

  useEffect(() => {
    return () => {
      speechAdapter.stop();
      demoControlsRef.current?.stop();
      stopVolumeMeter();
    };
  }, []);

  useEffect(() => {
    captionEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [visibleCaptions]);

  function addSessionEvent(event: SessionEvent) {
    setEvents((current) => [...current, event]);
  }

  function handleTranscriptEvent(event: ScenarioTranscriptEvent) {
    if (event.type === "sound_event") {
      const alert: SoundAlert = {
        id: event.id,
        label: event.eventLabel ?? event.text,
        timestamp: timeLabel(),
        critical: Boolean(event.critical),
      };
      setSoundAlerts((current) => [alert, ...current].slice(0, 4));
      if (alert.critical) {
        setFlashCritical(true);
      }
      addSessionEvent({
        type: "sound_event",
        timestamp: timeLabel(),
        payload: { label: alert.label, critical: alert.critical },
      });
      setStatusMessage(
        alert.critical
          ? `Critical sound detected: ${alert.label}.`
          : `Sound event detected: ${alert.label}.`,
      );
      return;
    }

    const speaker =
      selectedScenario.participants.find((participant) => participant.id === event.speakerId) ??
      selectedScenario.participants[0];
    const caption: CaptionSegment = {
      id: event.id,
      speakerId: speaker.id,
      speakerLabel: speaker.label,
      text: event.text,
      confidence: event.confidence ?? 0.82,
      timestamp: timeLabel(),
      plainLanguageText: plainLanguageEnabled ? event.plainLanguageText : undefined,
      entities: event.entities ?? extractEntities(event.text),
      isFocused: isFocusedText(event.entities ?? extractEntities(event.text), event.text),
      recoveryForId: pendingMissedMomentIdRef.current ?? undefined,
    };

    setCaptions((current) => [...current, caption]);
    if (pendingMissedMomentIdRef.current) {
      captureMissedMomentRecovery(pendingMissedMomentIdRef.current, caption.id);
    }
    addSessionEvent({
      type: "caption",
      timestamp: caption.timestamp,
      payload: { speaker: caption.speakerLabel, confidence: caption.confidence },
    });
    setStatusMessage(`Caption added for ${caption.speakerLabel}.`);
  }

  function startDemoScenario(scenario: Scenario) {
    resetSession(false);
    setSessionMode("demo");
    setListening(true);
    setStatusMessage(`${scenario.title} is running in reliable demo mode.`);
    addSessionEvent({
      type: "consent_state",
      timestamp: timeLabel(),
      payload: { mode: "demo", scenario: scenario.title },
    });
    demoControlsRef.current = playScenario(scenario, handleTranscriptEvent);
  }

  async function startLiveCaptions() {
    resetSession(false);
    setListening(true);
    setSessionMode("bridge");
    addSessionEvent({
      type: "consent_state",
      timestamp: timeLabel(),
      payload: { mode: "bridge", live: true },
    });

    if (!speechAdapter.isSupported()) {
      setStatusMessage(
        "This browser does not support live speech recognition. Lumen is ready in demo mode instead.",
      );
      startDemoScenario(selectedScenario);
      return;
    }

    void startVolumeMeter();

    speechAdapter.start(
      async (result) => {
        const rawText = sanitizeText(result.text);
        if (!rawText) return;

        const pendingRecoveryId = pendingMissedMomentIdRef.current;
        const cacheKey = `${result.resultIndex}:${pendingRecoveryId ?? "normal"}`;
        if (liveTranscriptCache.current[cacheKey] === rawText) return;
        liveTranscriptCache.current[cacheKey] = rawText;

        const baseId = `live-${result.resultIndex}`;
        const id =
          pendingRecoveryId && pendingMissedBeforeCaptionIdRef.current === baseId
            ? `${baseId}-repeat-${pendingRecoveryId}`
            : baseId;
        const entities = extractEntities(rawText);
        const caption: CaptionSegment = {
          id,
          speakerId: "live_a",
          speakerLabel: "Live speaker",
          text: rawText,
          confidence: result.confidence,
          timestamp: timeLabel(),
          entities,
          isFocused: isFocusedText(entities, rawText),
          recoveryForId: pendingRecoveryId ?? undefined,
        };

        setCaptions((current) => {
          const existingIndex = current.findIndex((item) => item.id === id);
          if (existingIndex >= 0) {
            const next = [...current];
            next[existingIndex] = caption;
            return next;
          }
          if (current.length >= MAX_CAPTIONS) return current;
          return [...current, caption];
        });

        if (plainLanguageEnabled && result.isFinal) {
          const plainLanguageText = await simplifySentence(rawText);
          setCaptions((current) =>
            current.map((item) =>
              item.id === id ? { ...item, plainLanguageText } : item,
            ),
          );
        }

        if (result.isFinal) {
          if (pendingRecoveryId) {
            captureMissedMomentRecovery(pendingRecoveryId, id);
          }
          addSessionEvent({
            type: "caption",
            timestamp: caption.timestamp,
            payload: { live: true, confidence: caption.confidence },
          });
        }
        setStatusMessage("Live captions are flowing.");
      },
      (message) => {
        setStatusMessage(message);
        startDemoScenario(selectedScenario);
      },
    );
  }

  function resetSession(clearSaved = true) {
    speechAdapter.stop();
    demoControlsRef.current?.stop();
    stopVolumeMeter();
    demoControlsRef.current = null;
    liveTranscriptCache.current = {};
    setListening(false);
    setMicLevel(0);
    setCaptions([]);
    setEvents([]);
    setSoundAlerts([]);
    setSelectedCaptionId(null);
    setHearingPrompt(null);
    setMissedMoments([]);
    setPendingMissedMomentId(null);
    pendingMissedMomentIdRef.current = null;
    pendingMissedBeforeCaptionIdRef.current = null;
    if (clearSaved) {
      setSaved(false);
    }
  }

  function endSession() {
    speechAdapter.stop();
    demoControlsRef.current?.stop();
    stopVolumeMeter();
    demoControlsRef.current = null;
    liveTranscriptCache.current = {};
    pendingMissedMomentIdRef.current = null;
    pendingMissedBeforeCaptionIdRef.current = null;
    setListening(false);
    setMicLevel(0);
    if (!saved) {
      setCaptions([]);
      setSoundAlerts([]);
      setEvents([]);
      setStatusMessage("Session ended. Unsaved data cleared by design.");
    } else {
      setStatusMessage("Session ended. Saved memory remains available for review.");
    }
  }

  function saveSession() {
    setSaved(true);
    addSessionEvent({
      type: "summary",
      timestamp: timeLabel(),
      payload: { summary: rollingSummary },
    });
    setStatusMessage("Session saved explicitly. Nothing syncs automatically.");
  }

  function replayCaption(caption: CaptionSegment) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(caption.text);
    utterance.rate = 0.9;
    window.speechSynthesis.speak(utterance);
  }

  function showHearingPrompt(message: string) {
    setHearingPrompt(message);
    setStatusMessage(`Showing request: ${message}`);
  }

  function markMissedMoment() {
    const momentId = `missed-${Date.now()}`;
    const beforeCaption = captions[captions.length - 1];

    setMissedMoments((current) => [
      ...current,
      {
        id: momentId,
        timestamp: timeLabel(),
        beforeCaptionId: beforeCaption?.id,
        status: "waiting",
      },
    ]);

    if (beforeCaption) {
      setCaptions((current) =>
        current.map((caption) =>
          caption.id === beforeCaption.id
            ? { ...caption, missedMomentId: momentId }
            : caption,
        ),
      );
    }

    setPendingMissedMomentId(momentId);
    pendingMissedMomentIdRef.current = momentId;
    pendingMissedBeforeCaptionIdRef.current = beforeCaption?.id ?? null;
    showHearingPrompt("Please repeat the last part. I missed it.");
  }

  function captureMissedMomentRecovery(momentId: string, captionId: string) {
    setMissedMoments((current) =>
      current.map((moment) =>
        moment.id === momentId
          ? { ...moment, recoveryCaptionId: captionId, status: "captured" }
          : moment,
      ),
    );
    setPendingMissedMomentId(null);
    pendingMissedMomentIdRef.current = null;
    pendingMissedBeforeCaptionIdRef.current = null;
    setStatusMessage("Repeat captured and linked to the missed moment.");
  }

  async function startVolumeMeter() {
    if (!navigator.mediaDevices?.getUserMedia) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 512;
      source.connect(analyser);

      const samples = new Uint8Array(analyser.fftSize);
      micStreamRef.current = stream;
      audioContextRef.current = audioContext;

      const updateLevel = () => {
        analyser.getByteTimeDomainData(samples);
        let sumSquares = 0;

        for (const sample of samples) {
          const normalized = (sample - 128) / 128;
          sumSquares += normalized * normalized;
        }

        const rms = Math.sqrt(sumSquares / samples.length);
        const nextLevel = Math.max(0, Math.min(1, (rms - 0.015) * 12));
        setMicLevel((current) => current * 0.5 + nextLevel * 0.5);
        volumeFrameRef.current = window.requestAnimationFrame(updateLevel);
      };

      updateLevel();
    } catch {
      setMicLevel(0);
    }
  }

  function stopVolumeMeter() {
    if (volumeFrameRef.current !== null) {
      window.cancelAnimationFrame(volumeFrameRef.current);
      volumeFrameRef.current = null;
    }

    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    void audioContextRef.current?.close();
    audioContextRef.current = null;
  }

  const selectedCaption = captions.find((caption) => caption.id === selectedCaptionId) ?? null;

  return (
    <div className="app-shell">
      {flashCritical && (
        <div
          className="critical-flash"
          onAnimationEnd={() => setFlashCritical(false)}
        />
      )}
      <div className="grain" />
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Lumen</p>
          <h1>Live captions for real conversations.</h1>
          <p className="hero-text">
            Start captions, keep the original words visible, and ask for repair
            when the transcript is uncertain.
          </p>
        </div>
      </header>

      <main className="layout">
        <section className="bridge-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Big Caption Mode</p>
              <h2>Follow the words first</h2>
            </div>
            <span className={`status-pill ${listening ? "live" : ""}`}>
              {listening ? (
                <span className="volume-dot" aria-hidden="true">
                  <span style={{ height: `${Math.round(micLevel * 100)}%` }} />
                </span>
              ) : null}
              {listening ? "Session live" : "Idle"}
            </span>
          </div>

          <div className="bridge-device">
            <div className="device-side device-side-user">
              <div className="panel-label">User side</div>
              <div className="bridge-stack">
                <div className="trust-banner" aria-live="polite">
                  <span className="dot" />
                  {statusMessage}
                </div>
                <section className="big-caption-stage" aria-live="polite" aria-label="Current caption">
                  {latestCaption ? (
                    <>
                      <div className="big-caption-meta">
                        <span>{latestCaption.speakerLabel}</span>
                        <span className={`confidence-badge ${confidenceState?.tone ?? ""}`}>
                          {confidenceState?.label}
                        </span>
                      </div>
                      <p>{latestCaption.text}</p>
                      {latestCaption.plainLanguageText ? (
                        <small>Plain language: {latestCaption.plainLanguageText}</small>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <div className="big-caption-meta">
                        <span>Ready</span>
                        <span className="confidence-badge">No speech yet</span>
                      </div>
                      <p>Press Start live captions and place the phone near the speaker.</p>
                    </>
                  )}
                </section>
                <div className="repair-actions">
                  <button
                    type="button"
                    className="missed-button"
                    onClick={markMissedMoment}
                  >
                    I missed that
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => showHearingPrompt("Please repeat that more slowly.")}
                  >
                    Repeat slowly
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => showHearingPrompt("Please face me while speaking.")}
                  >
                    Please face me
                  </button>
                </div>
                {pendingMissedMoment ? (
                  <div className="missed-status" aria-live="polite">
                    Waiting for the speaker to repeat the last part.
                  </div>
                ) : null}
                <div className="caption-stream">
                  {visibleCaptions.length === 0 ? (
                    <div className="empty-state">
                      <strong>Nothing captured yet.</strong>
                      <p>
                        Start live captions to see the full transcript history.
                        Use the repeat button if anything is unclear.
                      </p>
                    </div>
                  ) : (
                    visibleCaptions.map((caption) => (
                      <button
                        key={caption.id}
                        className={`caption-card ${selectedCaptionId === caption.id ? "active" : ""}`}
                        onClick={() => setSelectedCaptionId(caption.id)}
                        type="button"
                      >
                        <div className="caption-meta">
                          <span
                            className="speaker-chip"
                            style={{
                              background:
                                speakerPalette[caption.speakerId] ?? "#98ffd8",
                            }}
                          >
                            {caption.speakerLabel}
                          </span>
                          <span>{caption.timestamp}</span>
                          <span>{Math.round(caption.confidence * 100)}%</span>
                        </div>
                        {caption.missedMomentId ? (
                          <div className="moment-marker missed">
                            Missed moment marked here
                          </div>
                        ) : null}
                        {caption.recoveryForId ? (
                          <div className="moment-marker recovery">
                            Repeat attempt captured
                          </div>
                        ) : null}
                        <p
                          className="caption-text"
                          style={{ opacity: 0.45 + caption.confidence * 0.55 }}
                        >
                          {caption.text}
                        </p>
                        {caption.plainLanguageText ? (
                          <p className="plain-language">
                            Plain language: {caption.plainLanguageText}
                          </p>
                        ) : null}
                        {caption.entities?.length ? (
                          <div className="entity-row">
                            {caption.entities.map((entity) => (
                              <span key={entity} className="entity-pill">
                                {entity}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </button>
                    ))
                  )}
                  <div ref={captionEndRef} />
                </div>
              </div>
            </div>

            <div className="device-spine">
              <span />
              <span />
              <span />
            </div>

            <div className="device-side device-side-hearing">
              <div className="panel-label">Hearing side</div>
              <div className="consent-card hearing-card">
                <p className="eyebrow">For the speaker</p>
                {hearingPrompt ? (
                  <>
                    <h3>{hearingPrompt}</h3>
                    <p>Thanks. Short pauses and clear speech help captions stay reliable.</p>
                  </>
                ) : (
                  <>
                    <h3>I use live captions to understand speech.</h3>
                    <p>Please speak normally and face me when you can. Audio is not secretly recorded; notes are only saved if I choose to save them.</p>
                  </>
                )}
                <div className="consent-grid">
                  <div>
                    <span>Mic</span>
                    <strong>{listening ? "Listening now" : "Off"}</strong>
                  </div>
                  <div>
                    <span>Saving</span>
                    <strong>{saved ? "Saved by user" : "Not saved"}</strong>
                  </div>
                  <div>
                    <span>Best help</span>
                    <strong>Face the phone</strong>
                  </div>
                  <div>
                    <span>Repair</span>
                    <strong>Repeat if asked</strong>
                  </div>
                </div>
              </div>

              <div className="sound-panel">
                <p className="eyebrow">Sound Events</p>
                {soundAlerts.length === 0 ? (
                  <p className="muted">Critical non-speech alerts will surface here.</p>
                ) : (
                  soundAlerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={`sound-alert ${alert.critical ? "critical" : ""}`}
                    >
                      <strong>{alert.label}</strong>
                      <span>{alert.timestamp}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <aside className="control-panel">
          <section className="control-card">
            <p className="eyebrow">Session Controls</p>
            <div className="button-grid">
              <button type="button" onClick={startLiveCaptions}>
                Start live captions
              </button>
              <button type="button" className="secondary" onClick={saveSession}>
                Save session
              </button>
              <button type="button" className="ghost" onClick={endSession}>
                End session
              </button>
            </div>

            <div className="toggle-row">
              <button
                type="button"
                className={plainLanguageEnabled ? "toggle active" : "toggle"}
                onClick={() => setPlainLanguageEnabled((value) => !value)}
              >
                Plain language
              </button>
              <button
                type="button"
                className={focusEnabled ? "toggle active" : "toggle"}
                onClick={() => {
                  setFocusEnabled((value) => !value);
                  setSessionMode((mode) => (mode === "focus" ? "bridge" : "focus"));
                }}
              >
                Focus mode
              </button>
              <button
                type="button"
                className={sessionMode === "memory" ? "toggle active" : "toggle"}
                onClick={() => setSessionMode("memory")}
              >
                Memory view
              </button>
            </div>

            <label className="demo-checkbox">
              <input
                type="checkbox"
                checked={showDemoOptions}
                onChange={(event) => setShowDemoOptions(event.currentTarget.checked)}
              />
              <span>
                <strong>Show demo options</strong>
                <small>Use scripted captions when testing without a microphone.</small>
              </span>
            </label>

            {showDemoOptions ? (
              <div className="demo-options">
                <button
                  type="button"
                  className="secondary run-demo-button"
                  onClick={() => startDemoScenario(selectedScenario)}
                >
                  Run selected demo
                </button>

                <div className="scenario-list">
                  {scenarios.map((scenario) => (
                    <button
                      key={scenario.id}
                      type="button"
                      className={`scenario-card ${selectedScenario.id === scenario.id ? "active" : ""}`}
                      onClick={() => setSelectedScenarioId(scenario.id)}
                    >
                      <strong>{scenario.title}</strong>
                      <span>{scenario.context}</span>
                      <small>
                        {scenario.supportsLiveAudio
                          ? "Supports live audio fallback"
                          : "Scripted demo reliability"}
                      </small>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </section>

          <section className="control-card memory-card">
            <p className="eyebrow">Conversation Memory</p>
            <h3>Rolling summary</h3>
            <p>{rollingSummary}</p>
            <h3>Action items</h3>
            <div className="entity-row">
              {actionItems.length === 0 ? (
                <span className="muted">Names, dates, numbers, and tasks appear here.</span>
              ) : (
                actionItems.map((item) => (
                  <span key={item} className="entity-pill bright">
                    {item}
                  </span>
                ))
              )}
            </div>
            {missedMoments.length ? (
              <div className="missed-summary">
                <h3>Missed moments</h3>
                <p>
                  {missedMoments.filter((moment) => moment.status === "captured").length} of{" "}
                  {missedMoments.length} repeat attempts captured.
                </p>
              </div>
            ) : null}
            {selectedCaption ? (
              <div className="replay-card">
                <p className="eyebrow">Tap-to-replay</p>
                <strong>{selectedCaption.speakerLabel}</strong>
                <p>{selectedCaption.text}</p>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => replayCaption(selectedCaption)}
                >
                  Replay sentence
                </button>
              </div>
            ) : null}
          </section>
        </aside>
      </main>
    </div>
  );
}

function timeLabel() {
  return new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function extractEntities(text: string) {
  const matches = text.match(
    /\b(?:\d+%?|\d{1,2}:\d{2}|Room \d+|[A-Z][a-z]+(?:\s[A-Z][a-z]+)?|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|noon|tonight|tomorrow|May second)\b/g,
  );
  return matches ? Array.from(new Set(matches)).slice(0, 10) : [];
}

function isFocusedText(entities: string[], text: string) {
  return (
    entities.length > 0 ||
    /\b(agree|due|reserve|schedule|take|start|leave|count|message)\b/i.test(text)
  );
}

function confidenceLabel(confidence: number) {
  if (confidence >= 0.88) return { label: "High confidence", tone: "good" };
  if (confidence >= 0.72) return { label: "Check wording", tone: "warn" };
  return { label: "Uncertain", tone: "danger" };
}

export default App;
