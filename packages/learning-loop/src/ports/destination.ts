// Publication destination port and host registration (contract §Publication
// destination). The host, not adapter code, registers the immutable effect
// class, risk floor, permitted targets, authorization rule, and content
// policy; the engine parses and snapshots each registration at loop
// construction and computes effective risk by monotonic maximum. `prepare` is
// side-effect-free. Adapters parse any external `unknown` internally and
// return standardized effects and receipts; the engine re-validates both.
import type { Candidate, RiskTier } from "../records/candidate.js";
import type { EffectClass, PreparedEffect, PublicationReceipt } from "../records/publication.js";

export interface PublicationDestination {
  readonly id: string;

  prepare(input: { readonly candidate: Candidate; readonly expectedBase?: string }): Promise<readonly PreparedEffect[]>;

  applyEffect(input: { readonly effect: PreparedEffect; readonly idempotencyKey: string }): Promise<PublicationReceipt>;
}

export interface DestinationRegistration {
  readonly adapter: PublicationDestination;
  readonly effectClass: EffectClass;
  readonly riskFloor: RiskTier;
  readonly permittedTargetPatterns: readonly string[];
  readonly authorizationRuleId: string;
  readonly contentPolicyId: string;
}
