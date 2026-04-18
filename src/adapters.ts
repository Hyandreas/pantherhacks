import type { Scenario, ScenarioTranscriptEvent } from "./types";

type RecognitionCtor = new () => {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

declare global {
  interface Window {
    webkitSpeechRecognition?: RecognitionCtor;
    SpeechRecognition?: RecognitionCtor;
  }
}

export interface LiveCaptionResult {
  text: string;
  confidence: number;
}

export interface LiveCaptionAdapter {
  isSupported(): boolean;
  start(
    onCaption: (result: LiveCaptionResult) => void,
    onError: (message: string) => void,
  ): void;
  stop(): void;
}

export class BrowserSpeechAdapter implements LiveCaptionAdapter {
  private recognition:
    | InstanceType<RecognitionCtor>
    | undefined;

  isSupported() {
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  start(
    onCaption: (result: LiveCaptionResult) => void,
    onError: (message: string) => void,
  ) {
    const Recognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!Recognition) {
      onError("Live microphone captions are unavailable in this browser.");
      return;
    }

    this.recognition = new Recognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";

    this.recognition.onresult = (event: Event) => {
      const speechEvent = event as Event & {
        results: ArrayLike<{
          isFinal: boolean;
          0: { transcript: string; confidence?: number };
        }>;
        resultIndex: number;
      };

      for (let i = speechEvent.resultIndex; i < speechEvent.results.length; i += 1) {
        const result = speechEvent.results[i];
        if (!result) continue;
        const transcript = result[0]?.transcript?.trim();
        if (!transcript) continue;
        onCaption({
          text: transcript,
          confidence: result[0]?.confidence ?? (result.isFinal ? 0.88 : 0.62),
        });
      }
    };

    this.recognition.onerror = (event: Event) => {
      const speechEvent = event as Event & { error?: string };
      onError(
        speechEvent.error === "not-allowed"
          ? "Microphone permission was denied. Lumen switched cleanly to demo mode."
          : "Live recognition paused. Demo mode is ready as a fallback.",
      );
    };

    this.recognition.onend = () => {
      this.recognition = undefined;
    };

    this.recognition.start();
  }

  stop() {
    this.recognition?.stop();
    this.recognition = undefined;
  }
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
