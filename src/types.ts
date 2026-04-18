export type SessionMode = "bridge" | "focus" | "memory" | "demo";

export type EventKind =
  | "caption"
  | "sound_event"
  | "summary"
  | "action_item"
  | "consent_state";

export interface ScenarioParticipant {
  id: string;
  label: string;
  role: "user" | "hearing" | "staff" | "speaker" | "system";
  accentColor: string;
}

export interface ScenarioTranscriptEvent {
  id: string;
  type: "caption" | "sound_event";
  speakerId?: string;
  text: string;
  plainLanguageText?: string;
  confidence?: number;
  entities?: string[];
  delayMs: number;
  eventLabel?: string;
  critical?: boolean;
}

export interface Scenario {
  id: string;
  title: string;
  context: string;
  participants: ScenarioParticipant[];
  transcript: ScenarioTranscriptEvent[];
  supportsLiveAudio: boolean;
  expectedHighlights: string[];
}

export interface CaptionSegment {
  id: string;
  speakerId: string;
  speakerLabel: string;
  text: string;
  confidence: number;
  timestamp: string;
  plainLanguageText?: string;
  entities?: string[];
  isFocused: boolean;
  missedMomentId?: string;
  recoveryForId?: string;
}

export interface SessionEvent {
  type: EventKind;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface SoundAlert {
  id: string;
  label: string;
  timestamp: string;
  critical: boolean;
}
