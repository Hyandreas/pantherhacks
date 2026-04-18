import type { Scenario } from "./types";

export const scenarios: Scenario[] = [
  {
    id: "restaurant",
    title: "Restaurant Table",
    context:
      "Noisy dinner service. Two friends are splitting plates while a server moves quickly through specials.",
    supportsLiveAudio: true,
    expectedHighlights: [
      "Bridge Mode consent is visible from the first second",
      "Sound event detection surfaces applause and name-calling",
      "Confidence fades in the noisiest moments",
    ],
    participants: [
      { id: "a", label: "Maya", role: "hearing", accentColor: "#98ffd8" },
      { id: "b", label: "Server", role: "staff", accentColor: "#ffd18b" },
      { id: "c", label: "You", role: "user", accentColor: "#d6c2ff" },
    ],
    transcript: [
      {
        id: "r1",
        type: "caption",
        speakerId: "a",
        text: "They just brought the roasted mushrooms. Do you still want to split them?",
        plainLanguageText:
          "Maya says the mushrooms arrived and asks if you still want to share them.",
        confidence: 0.96,
        entities: ["roasted mushrooms"],
        delayMs: 1200,
      },
      {
        id: "r2",
        type: "sound_event",
        text: "Applause nearby",
        eventLabel: "applause",
        critical: false,
        delayMs: 900,
      },
      {
        id: "r3",
        type: "caption",
        speakerId: "b",
        text: "Our special tonight is pan-seared cod with fennel, and the kitchen closes at nine thirty.",
        plainLanguageText:
          "The server says the special is cod with fennel, and orders must be in before 9:30.",
        confidence: 0.73,
        entities: ["pan-seared cod", "nine thirty"],
        delayMs: 1800,
      },
      {
        id: "r4",
        type: "sound_event",
        text: "Name called: Maya",
        eventLabel: "name called",
        critical: true,
        delayMs: 700,
      },
      {
        id: "r5",
        type: "caption",
        speakerId: "a",
        text: "Let’s do the cod, and can you remind me what time we promised to leave for the lecture?",
        plainLanguageText:
          "Maya wants the cod and asks what time you agreed to leave for the lecture.",
        confidence: 0.91,
        entities: ["cod", "lecture"],
        delayMs: 1600,
      },
    ],
  },
  {
    id: "doctor",
    title: "Doctor Visit",
    context:
      "A primary-care follow-up where medication timing and next steps matter more than raw transcript volume.",
    supportsLiveAudio: true,
    expectedHighlights: [
      "Plain language preserves meaning without blocking captions",
      "Focus Mode pulls dates, dosage, and action items",
      "Memory view makes the agreement review obvious",
    ],
    participants: [
      { id: "a", label: "Dr. Chen", role: "speaker", accentColor: "#98ffd8" },
      { id: "b", label: "Nurse", role: "staff", accentColor: "#ffd18b" },
      { id: "c", label: "You", role: "user", accentColor: "#d6c2ff" },
    ],
    transcript: [
      {
        id: "d1",
        type: "caption",
        speakerId: "a",
        text: "Your blood pressure has improved, but I want you taking ten milligrams every morning with food for the next six weeks.",
        plainLanguageText:
          "Dr. Chen says your blood pressure is better. Take 10 mg each morning with food for 6 weeks.",
        confidence: 0.95,
        entities: ["ten milligrams", "every morning", "six weeks"],
        delayMs: 1200,
      },
      {
        id: "d2",
        type: "caption",
        speakerId: "a",
        text: "Schedule the lab draw before May second, and message me if you feel dizzy again.",
        plainLanguageText:
          "Get your lab work done before May 2. Contact Dr. Chen if dizziness happens again.",
        confidence: 0.94,
        entities: ["May second", "dizzy"],
        delayMs: 1500,
      },
      {
        id: "d3",
        type: "sound_event",
        text: "Door knock",
        eventLabel: "door knock",
        critical: false,
        delayMs: 800,
      },
      {
        id: "d4",
        type: "caption",
        speakerId: "b",
        text: "I’ll print your visit summary, but the medication change starts tonight only if the pharmacy has it ready.",
        plainLanguageText:
          "The nurse will print a summary. Start the new medication tonight only if the pharmacy has it ready.",
        confidence: 0.86,
        entities: ["tonight", "pharmacy"],
        delayMs: 1700,
      },
    ],
  },
  {
    id: "lecture",
    title: "Lecture / Service Counter",
    context:
      "A fast-paced lecture intro with assignment dates, room changes, and one missed key instruction.",
    supportsLiveAudio: false,
    expectedHighlights: [
      "Demo Mode remains strong even without microphone access",
      "Speaker labels and entity extraction support note-taking",
      "Action items read like a real accessibility safety net",
    ],
    participants: [
      { id: "a", label: "Professor", role: "speaker", accentColor: "#98ffd8" },
      { id: "b", label: "TA", role: "staff", accentColor: "#ffd18b" },
      { id: "c", label: "You", role: "user", accentColor: "#d6c2ff" },
    ],
    transcript: [
      {
        id: "l1",
        type: "caption",
        speakerId: "a",
        text: "Your prototype critique has moved to Room 204, and the revised slides are due by noon on Tuesday.",
        plainLanguageText:
          "The critique is now in Room 204. Updated slides are due Tuesday at noon.",
        confidence: 0.97,
        entities: ["Room 204", "Tuesday", "noon"],
        delayMs: 1100,
      },
      {
        id: "l2",
        type: "caption",
        speakerId: "b",
        text: "If you need equipment, reserve it by five p.m. tomorrow through the media desk.",
        plainLanguageText:
          "Reserve equipment by 5 p.m. tomorrow using the media desk.",
        confidence: 0.89,
        entities: ["five p.m. tomorrow", "media desk"],
        delayMs: 1500,
      },
      {
        id: "l3",
        type: "sound_event",
        text: "Fire alarm test",
        eventLabel: "alarm",
        critical: true,
        delayMs: 900,
      },
      {
        id: "l4",
        type: "caption",
        speakerId: "a",
        text: "Do not forget that peer review comments count for ten percent of the final grade.",
        plainLanguageText:
          "Peer review comments are worth 10% of the final grade.",
        confidence: 0.93,
        entities: ["ten percent", "final grade"],
        delayMs: 1400,
      },
    ],
  },
];
