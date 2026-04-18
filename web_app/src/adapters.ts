import type { Scenario, ScenarioTranscriptEvent } from "./types";

const DEEPGRAM_PROXY_URL =
  import.meta.env.VITE_DEEPGRAM_PROXY_URL ?? "ws://127.0.0.1:8788/captions";
const DEEPGRAM_CHUNK_MS = 250;

export interface LiveCaptionResult {
  text: string;
  confidence: number;
  resultIndex: number;
  isFinal: boolean;
}

export interface LiveCaptionAdapter {
  isSupported(): boolean;
  start(
    onCaption: (result: LiveCaptionResult) => void,
    onError: (message: string) => void,
  ): void;
  stop(): void;
}

interface DeepgramResultMessage {
  type?: string;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
  start?: number;
  is_final?: boolean;
  speech_final?: boolean;
  error?: string;
}

export class DeepgramCaptionAdapter implements LiveCaptionAdapter {
  private recorder: MediaRecorder | undefined;
  private socket: WebSocket | undefined;
  private stream: MediaStream | undefined;
  private fallbackIndex = 0;

  isSupported() {
    return (
      "WebSocket" in window &&
      "MediaRecorder" in window &&
      Boolean(navigator.mediaDevices?.getUserMedia)
    );
  }

  async start(
    onCaption: (result: LiveCaptionResult) => void,
    onError: (message: string) => void,
  ) {
    if (!this.isSupported()) {
      onError("Live microphone streaming is not available in this browser.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const socket = new WebSocket(DEEPGRAM_PROXY_URL);

      this.stream = stream;
      this.socket = socket;

      socket.onopen = () => {
        const recorder = createMediaRecorder(stream);
        this.recorder = recorder;

        recorder.ondataavailable = (event) => {
          if (event.data.size > 0 && socket.readyState === WebSocket.OPEN) {
            socket.send(event.data);
          }
        };

        recorder.start(DEEPGRAM_CHUNK_MS);
      };

      socket.onmessage = (event) => {
        const message = parseDeepgramMessage(event.data);
        if (!message) return;

        if (message.type === "Error") {
          onError(message.error ?? "Deepgram captioning failed.");
          return;
        }

        if (message.type !== "Results") return;

        const alternative = message.channel?.alternatives?.[0];
        const text = alternative?.transcript?.trim();
        if (!text || !alternative) return;

        const resultIndex =
          typeof message.start === "number"
            ? Math.round(message.start * 1000)
            : this.fallbackIndex;

        onCaption({
          text,
          confidence: alternative.confidence ?? 0.82,
          resultIndex,
          isFinal: Boolean(message.is_final || message.speech_final),
        });

        if (message.is_final || message.speech_final) {
          this.fallbackIndex += 1;
        }
      };

      socket.onerror = () => {
        onError("Deepgram proxy is unavailable. Start deepgram_server first.");
      };

      socket.onclose = () => {
        if (this.recorder?.state === "recording") {
          onError("Deepgram captions disconnected. Check the deepgram_server terminal.");
        }
      };
    } catch {
      onError("Microphone permission was denied or Deepgram captions could not start.");
    }
  }

  stop() {
    if (this.recorder?.state !== "inactive") {
      this.recorder?.stop();
    }
    this.recorder = undefined;
    this.socket?.close();
    this.socket = undefined;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    this.fallbackIndex = 0;
  }
}

function parseDeepgramMessage(data: MessageEvent["data"]) {
  if (typeof data !== "string") return null;

  try {
    return JSON.parse(data) as DeepgramResultMessage;
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

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
}

function createMediaRecorder(stream: MediaStream) {
  const mimeType = chooseMimeType();
  return mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
}

export interface DemoAdapterControls {
  stop: () => void;
}

export function playScenario(
  scenario: Scenario,
  onEvent: (event: ScenarioTranscriptEvent) => void,
): DemoAdapterControls {
  const timers = scenario.transcript.map((event, index) =>
    window.setTimeout(() => onEvent(event), cumulativeDelay(scenario, index)),
  );

  return {
    stop: () => timers.forEach(window.clearTimeout),
  };
}

function cumulativeDelay(scenario: Scenario, index: number) {
  return scenario.transcript
    .slice(0, index + 1)
    .reduce((sum, event) => sum + event.delayMs, 0);
}

export function simplifySentence(text: string) {
  return new Promise<string>((resolve) => {
    window.setTimeout(() => {
      const simplified = text
        .replace(/approximately/gi, "about")
        .replace(/for the next/gi, "for")
        .replace(/do not forget that/gi, "")
        .replace(/\s+/g, " ")
        .trim();
      resolve(simplified);
    }, 550);
  });
}
