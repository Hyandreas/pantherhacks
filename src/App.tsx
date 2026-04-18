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

function sanitizeText(text: string): string {
  return text.slice(0, 500).replace(/[<>]/g, "");
}

function App() {
  const [sessionMode, setSessionMode] = useState<SessionMode>("bridge");
  const [selectedScenarioId, setSelectedScenarioId] = useState(scenarios[0].id);
  const [captions, setCaptions] = useState<CaptionSegment[]>([]);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [soundAlerts, setSoundAlerts] = useState<SoundAlert[]>([]);
  const [listening, setListening] = useState(false);
  const [plainLanguageEnabled, setPlainLanguageEnabled] = useState(true);
  const [focusEnabled, setFocusEnabled] = useState(false);
  const [saved, setSaved] = useState(false);
  const [statusMessage, setStatusMessage] = useState(
    "Consent-first bridge mode is ready. Start live captions or run a scenario.",
  );
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [flashCritical, setFlashCritical] = useState(false);
  const demoControlsRef = useRef<DemoAdapterControls | null>(null);
  const transcriptCounter = useRef(0);
  const liveSpeakerIndex = useRef(0);
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

  useEffect(() => {
    return () => {
      speechAdapter.stop();
      demoControlsRef.current?.stop();
    };
  }, []);

  useEffect(() => {
    captionEndRef.current?.scrollIntoView({ behavior: "smooth" });
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
    };

    setCaptions((current) => [...current, caption]);
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

    speechAdapter.start(
      async (result) => {
        const rawText = sanitizeText(result.text);
        if (!rawText) return;

        const id = `live-${transcriptCounter.current}`;
        transcriptCounter.current += 1;
        const speakerIdx = liveSpeakerIndex.current % 3;
        liveSpeakerIndex.current += 1;
        const speakerId = `live_${String.fromCharCode(97 + speakerIdx)}`;
        const entities = extractEntities(rawText);
        const caption: CaptionSegment = {
          id,
          speakerId,
          speakerLabel: `Speaker ${String.fromCharCode(65 + speakerIdx)}`,
          text: rawText,
          confidence: result.confidence,
          timestamp: timeLabel(),
          entities,
          isFocused: isFocusedText(entities, rawText),
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

        if (plainLanguageEnabled) {
          const plainLanguageText = await simplifySentence(rawText);
          setCaptions((current) =>
            current.map((item) =>
              item.id === id ? { ...item, plainLanguageText } : item,
            ),
          );
        }

        addSessionEvent({
          type: "caption",
          timestamp: caption.timestamp,
          payload: { live: true, confidence: caption.confidence },
        });
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
    demoControlsRef.current = null;
    setListening(false);
    setCaptions([]);
    setEvents([]);
    setSoundAlerts([]);
    setSelectedCaptionId(null);
    if (clearSaved) {
      setSaved(false);
    }
  }

  function endSession() {
    speechAdapter.stop();
    demoControlsRef.current?.stop();
    demoControlsRef.current = null;
    setListening(false);
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
          <h1>Making spoken language visible.</h1>
          <p className="hero-text">
            A privacy-first accessibility assistant for hard-of-hearing,
            late-deafened, and speech-processing-challenged adults.
          </p>
        </div>
        <div className="hero-metrics">
          <div className="metric-card">
            <span>Core insight</span>
            <strong>Bridge Mode</strong>
          </div>
          <div className="metric-card">
            <span>Hackathon surface</span>
            <strong>Web demo</strong>
          </div>
          <div className="metric-card">
            <span>Trust rule</span>
            <strong>Visible consent</strong>
          </div>
        </div>
      </header>

      <main className="layout">
        <section className="bridge-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Bridge Mode</p>
              <h2>Phone-between-you conversation design</h2>
            </div>
            <span className={`status-pill ${listening ? "live" : ""}`}>
              {listening ? "Session live" : "Idle"}
            </span>
          </div>

          <div className="bridge-device">
            <div className="device-side device-side-user">
              <div className="panel-label">User side</div>
              <div className="bridge-stack">
                <div className="trust-banner">
                  <span className="dot" />
                  {statusMessage}
                </div>
                <div className="caption-stream">
                  {visibleCaptions.length === 0 ? (
                    <div className="empty-state">
                      <strong>Nothing captured yet.</strong>
                      <p>
                        Start live captions or run a scenario to see confidence,
                        speaker labels, focus mode, memory, and plain language.
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
              <div className="consent-card">
                <p className="eyebrow">Accessibility Notice</p>
                <h3>This conversation is being captioned for accessibility.</h3>
                <p>
                  Captions are visible to both sides. Audio is not hidden, and
                  session memory only persists if the user explicitly saves it.
                </p>
                <div className="consent-grid">
                  <div>
                    <span>Audio</span>
                    <strong>Visible in-session only</strong>
                  </div>
                  <div>
                    <span>Cloud</span>
                    <strong>Text-only plain language</strong>
                  </div>
                  <div>
                    <span>Retention</span>
                    <strong>Ends unless saved</strong>
                  </div>
                  <div>
                    <span>Fallback</span>
                    <strong>Scenario demo mode</strong>
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
              <button
                type="button"
                className="secondary"
                onClick={() => startDemoScenario(selectedScenario)}
              >
                Run demo scenario
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
          </section>

          <section className="control-card">
            <p className="eyebrow">Demo Mode</p>
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

          <section className="control-card architecture-card">
            <p className="eyebrow">Feature Coverage</p>
            <ul>
              <li>Live captions with confidence</li>
              <li>Bridge Mode consent surface</li>
              <li>Speaker-labeled caption bubbles</li>
              <li>Plain language layer</li>
              <li>Sound event detection</li>
              <li>Conversation memory + replay</li>
              <li>Focus mode</li>
            </ul>
            <div className="event-log">
              <p className="eyebrow">Session Event Log</p>
              {events.length === 0 ? (
                <p className="muted">Consent, caption, summary, and sound events appear here.</p>
              ) : (
                events.slice(-5).reverse().map((event, index) => (
                  <div key={`${event.timestamp}-${event.type}-${index}`} className="event-row">
                    <strong>{event.type}</strong>
                    <span>{event.timestamp}</span>
                  </div>
                ))
              )}
            </div>
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

export default App;
