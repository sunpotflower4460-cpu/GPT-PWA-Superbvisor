// Context pressure detection (design item #18/#D: "context pressure ->
// checkpoint/handoff"). Deliberately NOT a token-count measurement: this
// Worker orchestrates a DeveloperJob via GitHub state and the Chat Control
// Bus — it never sees the ChatGPT conversation's own context window, so it
// has no way to know how full that conversation actually is. Any signal
// this module derives is a PROXY built from what the Worker genuinely does
// track on a job (how many distinct recovery cycles and route checkpoints
// it has been through), not a measurement — advisory only, same spirit as
// GPT-template's no-ai-default-palette check ("誤検知よりも判定不能の方が安全").
export type ContextPressureLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ContextPressureInput {
  recoveryCount: number;
  routeCheckpointCount: number;
}

const MEDIUM_THRESHOLD = 5;
const HIGH_THRESHOLD = 12;

export function deriveContextPressure(input: ContextPressureInput): ContextPressureLevel {
  const signal = Math.max(0, input.recoveryCount) + Math.max(0, input.routeCheckpointCount);
  if (signal >= HIGH_THRESHOLD) return 'HIGH';
  if (signal >= MEDIUM_THRESHOLD) return 'MEDIUM';
  return 'LOW';
}
