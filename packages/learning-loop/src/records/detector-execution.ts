// Immutable receipt for one exact detector invocation and its closed result.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { LearningLoopError } from "../diagnostics.js";
import { invalid, parseBool, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { DetectorOutputKind } from "./detector-registration.js";
import type { EvidenceRef } from "./evidence-ref.js";
import { parseEvidenceRefAt } from "./evidence-ref.js";
import type { Scope } from "./scope.js";
import type { DetectorRef, LensRef, PackRef } from "./semantic-shared.js";
import {
  assertSortedUnique,
  canonicalKey,
  digestOf,
  MAX_ORDERED_VALUES,
  MAX_SET_VALUES,
  parseBoundedArray,
  parseDetectorRefAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  parseLensRefAt,
  parseNullable,
  parsePackRefAt,
  parseScopeAt,
  scopeDigest,
} from "./semantic-shared.js";
import type { SourceSemanticProfile } from "./source-semantic-profile.js";
import { parseSourceSemanticProfile } from "./source-semantic-profile.js";
import type { EvidenceHealthFinding } from "./source-health.js";
import { parseEvidenceHealthFinding } from "./source-health.js";

const DETECTOR_EXECUTION_STATUSES = ["applied", "not_applicable", "incomplete"] as const;
const DETECTOR_OUTPUT_KINDS: readonly DetectorOutputKind[] = ["evidence_health", "insight_derivation"];
const DETECTOR_EXECUTION_ID_PATTERN = /^detector-execution-[0-9a-f]{64}$/;
const INSIGHT_ID_PATTERN = /^insight-[0-9a-f]{64}$/;

export type DetectorExecutionStatus = (typeof DETECTOR_EXECUTION_STATUSES)[number];

interface DetectorExecutionPopulationEpisode {
  readonly episodeRecordId: string;
  readonly episodeRecordDigest: string;
  readonly episodeIdentityDigest: string;
  readonly outcomeClaimDigest: string | null;
  readonly episodeViewDigest: string;
  readonly scopeDigest: string;
}

interface DetectorExecutionDerivationRef {
  readonly id: string;
  readonly derivationDigest: string;
  readonly scopeDigest: string;
}

type DetectorExecutionResult =
  | {
      readonly status: "applied";
      readonly conditionDetected: boolean;
      readonly derivationRefs: readonly DetectorExecutionDerivationRef[];
      readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
    }
  | {
      readonly status: "not_applicable" | "incomplete";
      readonly reasonCodes: readonly string[];
      readonly missingCapabilities: readonly string[];
    };

export interface DetectorExecutionRecord {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly loopRegistryRevision: string;
  readonly detector: DetectorRef & {
    readonly configurationDigest: string;
    readonly implementationDigest: string;
  };
  readonly pack: PackRef;
  readonly lens: LensRef | null;
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly outputKind: DetectorOutputKind;
  readonly window: {
    readonly sourceProfiles: readonly SourceSemanticProfile[];
    readonly population: {
      readonly episodes: readonly DetectorExecutionPopulationEpisode[];
      readonly normalizationPolicyDigest: string;
      readonly comparabilityPolicyDigest: string | null;
      readonly populationDigest: string;
    };
    readonly evidenceRefs: readonly EvidenceRef[];
    readonly evidenceHealthFindings: readonly EvidenceHealthFinding[];
    readonly availableCapabilities: readonly string[];
    readonly windowDigest: string;
  };
  readonly result: DetectorExecutionResult;
  readonly executionKeyDigest: string;
  readonly executionDigest: string;
}

type DetectorExecutionKeyInput = Omit<
  DetectorExecutionRecord,
  "schemaVersion" | "id" | "result" | "executionKeyDigest" | "executionDigest"
>;

type DetectorExecutionDigestInput = Omit<DetectorExecutionRecord, "schemaVersion" | "id" | "executionDigest">;

function detectorExecutionKeyContent(input: DetectorExecutionKeyInput): JsonValue {
  return toJsonValue({
    loopRegistryRevision: input.loopRegistryRevision,
    detector: input.detector,
    pack: input.pack,
    lens: input.lens,
    scope: input.scope,
    scopeDigest: input.scopeDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    outputKind: input.outputKind,
    window: input.window,
  });
}

export function detectorExecutionKeyDigest(input: DetectorExecutionKeyInput): string {
  return sha256HexOfCanonicalJson(detectorExecutionKeyContent(input));
}

function detectorExecutionContent(input: DetectorExecutionDigestInput): JsonValue {
  return toJsonValue({
    loopRegistryRevision: input.loopRegistryRevision,
    detector: input.detector,
    pack: input.pack,
    lens: input.lens,
    scope: input.scope,
    scopeDigest: input.scopeDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    outputKind: input.outputKind,
    window: input.window,
    result: input.result,
    executionKeyDigest: input.executionKeyDigest,
  });
}

export function detectorExecutionDigest(input: DetectorExecutionDigestInput): string {
  return sha256HexOfCanonicalJson(detectorExecutionContent(input));
}

function parseNestedRecordAt<T>(
  input: unknown,
  path: readonly (string | number)[],
  parseRecord: (value: unknown) => T,
): T {
  try {
    return parseRecord(input);
  } catch (error) {
    if (error instanceof LearningLoopError) {
      const diagnostics = error.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: [...path, ...(diagnostic.path ?? [])],
      }));
      throw new LearningLoopError(error.code, diagnostics);
    }
    throw error;
  }
}

const parseSourceSemanticProfileAt: Parse<SourceSemanticProfile> = (input, path) =>
  parseNestedRecordAt(input, path, parseSourceSemanticProfile);

const parseEvidenceHealthFindingAt: Parse<EvidenceHealthFinding> = (input, path) =>
  parseNestedRecordAt(input, path, parseEvidenceHealthFinding);

function assertEvidenceHealthFindingsUnique(
  findings: readonly EvidenceHealthFinding[],
  path: readonly (string | number)[],
): void {
  assertSortedUnique(findings, (finding) => canonicalKey([finding.id, finding.findingDigest]), path);
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const [index, finding] of findings.entries()) {
    if (ids.has(finding.id) || digests.has(finding.findingDigest)) {
      throw invalid("schema.invalid", "evidence-health findings may be included only once", [...path, index]);
    }
    ids.add(finding.id);
    digests.add(finding.findingDigest);
  }
}

function parseEvidenceHealthFindingsAt(
  input: unknown,
  path: readonly (string | number)[],
): readonly EvidenceHealthFinding[] {
  const findings = parseBoundedArray(
    parseEvidenceHealthFindingAt,
    MAX_SET_VALUES,
    "evidence-health findings",
  )(input, path);
  assertEvidenceHealthFindingsUnique(findings, path);
  return findings;
}

function parsePopulationEpisodeAt(
  input: unknown,
  path: readonly (string | number)[],
): DetectorExecutionPopulationEpisode {
  const fields = readFields(input, path);
  const episodeRecordId = fields.req("episodeRecordId", parseDurableId);
  const episodeRecordDigest = fields.req("episodeRecordDigest", parseDigestAt);
  const episodeIdentityDigest = fields.req("episodeIdentityDigest", parseDigestAt);
  const outcomeClaimDigest = fields.req("outcomeClaimDigest", parseNullable(parseDigestAt));
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  const episodeViewDigest = fields.req("episodeViewDigest", parseDigestAt);
  if (
    episodeViewDigest !==
    digestOf({
      episodeRecordId,
      episodeRecordDigest,
      episodeIdentityDigest,
      outcomeClaimDigest,
      scopeDigest: exactScopeDigest,
    })
  ) {
    throw invalid("schema.corrupt", "episode view digest does not match its immutable components", [
      ...path,
      "episodeViewDigest",
    ]);
  }
  return {
    episodeRecordId,
    episodeRecordDigest,
    episodeIdentityDigest,
    outcomeClaimDigest,
    episodeViewDigest,
    scopeDigest: exactScopeDigest,
  };
}

function assertPopulationEpisodesUnique(
  episodes: readonly DetectorExecutionPopulationEpisode[],
  path: readonly (string | number)[],
): void {
  const recordIds = new Set<string>();
  const identityDigests = new Set<string>();
  const viewDigests = new Set<string>();
  for (const [index, episode] of episodes.entries()) {
    if (
      recordIds.has(episode.episodeRecordId) ||
      identityDigests.has(episode.episodeIdentityDigest) ||
      viewDigests.has(episode.episodeViewDigest)
    ) {
      throw invalid("schema.invalid", "ordered population episodes must be unique", [...path, index]);
    }
    recordIds.add(episode.episodeRecordId);
    identityDigests.add(episode.episodeIdentityDigest);
    viewDigests.add(episode.episodeViewDigest);
  }
}

function parseEvidenceRefsAt(input: unknown, path: readonly (string | number)[]): readonly EvidenceRef[] {
  const values = parseBoundedArray(parseEvidenceRefAt, MAX_ORDERED_VALUES, "evidence references")(input, path);
  const digests = new Set<string>();
  const records = new Set<string>();
  for (const [index, value] of values.entries()) {
    const recordKey = canonicalKey([value.kind, value.recordId]);
    if (digests.has(value.referenceDigest) || records.has(recordKey)) {
      throw invalid("schema.invalid", "ordered evidence references must be unique", [...path, index]);
    }
    digests.add(value.referenceDigest);
    records.add(recordKey);
  }
  return values;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileKey(profile: SourceSemanticProfile): string {
  return canonicalKey([profile.sourceId, profile.sourceRegistrationRevision, profile.profileDigest]);
}

function assertSourceProfilesUnique(
  profiles: readonly SourceSemanticProfile[],
  path: readonly (string | number)[],
): void {
  assertSortedUnique(profiles, profileKey, path);
  const sourceRevisions = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    const sourceRevision = canonicalKey([profile.sourceId, profile.sourceRegistrationRevision]);
    if (sourceRevisions.has(sourceRevision)) {
      throw invalid("schema.invalid", "a source registration revision may have only one semantic profile", [
        ...path,
        index,
      ]);
    }
    sourceRevisions.add(sourceRevision);
  }
}

function exactAvailableCapabilities(profiles: readonly SourceSemanticProfile[]): readonly string[] {
  const capabilities = new Set<string>();
  for (const profile of profiles) {
    for (const capability of profile.capabilities) capabilities.add(capability);
  }
  return [...capabilities].sort(compareText);
}

function sourceProfileRevisionKeys(profiles: readonly SourceSemanticProfile[]): ReadonlySet<string> {
  return new Set(profiles.map((profile) => canonicalKey([profile.sourceId, profile.sourceRegistrationRevision])));
}

function assertFindingSources(
  findings: readonly EvidenceHealthFinding[],
  profiles: readonly SourceSemanticProfile[],
  path: readonly (string | number)[],
): void {
  const sourceRevisions = sourceProfileRevisionKeys(profiles);
  for (const [index, finding] of findings.entries()) {
    if (!sourceRevisions.has(canonicalKey([finding.sourceId, finding.sourceRegistrationRevision]))) {
      throw invalid("schema.corrupt", "evidence-health finding has no exact source semantic profile", [...path, index]);
    }
  }
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

type DetectorExecutionWindow = DetectorExecutionRecord["window"];

function parseExecutionWindowAt(
  input: unknown,
  path: readonly (string | number)[],
  exactScopeDigest: string,
  loopRegistryRevision: string,
): DetectorExecutionWindow {
  const fields = readFields(input, path);
  const sourceProfiles = fields.req(
    "sourceProfiles",
    parseBoundedArray(parseSourceSemanticProfileAt, MAX_SET_VALUES, "source semantic profiles"),
  );
  assertSourceProfilesUnique(sourceProfiles, [...path, "sourceProfiles"]);

  const populationFields = readFields(
    fields.req("population", (value) => value),
    [...path, "population"],
  );
  const episodes = populationFields.req(
    "episodes",
    parseBoundedArray(parsePopulationEpisodeAt, MAX_ORDERED_VALUES, "population episodes"),
  );
  assertPopulationEpisodesUnique(episodes, [...path, "population", "episodes"]);
  for (const [index, episode] of episodes.entries()) {
    if (episode.scopeDigest !== exactScopeDigest) {
      throw invalid("schema.corrupt", "population episode scope does not match execution scope", [
        ...path,
        "population",
        "episodes",
        index,
        "scopeDigest",
      ]);
    }
    const matchingProfiles = sourceProfiles.filter((profile) =>
      episode.episodeRecordId.startsWith(`${profile.sourceId}/`),
    );
    if (matchingProfiles.length !== 1) {
      throw invalid("schema.corrupt", "population episode has no unique source semantic profile", [
        ...path,
        "population",
        "episodes",
        index,
        "episodeRecordId",
      ]);
    }
  }
  const normalizationPolicyDigest = populationFields.req("normalizationPolicyDigest", parseDigestAt);
  const comparabilityPolicyDigest = populationFields.req("comparabilityPolicyDigest", parseNullable(parseDigestAt));
  const populationDigest = populationFields.req("populationDigest", parseDigestAt);
  if (populationDigest !== digestOf({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest })) {
    throw invalid("schema.corrupt", "population digest does not match its episodes and policies", [
      ...path,
      "population",
      "populationDigest",
    ]);
  }
  const population = {
    episodes,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
    populationDigest,
  };

  const evidenceRefs = fields.req("evidenceRefs", parseEvidenceRefsAt);
  const profileSourceRevisions = sourceProfileRevisionKeys(sourceProfiles);
  for (const [index, reference] of evidenceRefs.entries()) {
    if (reference.episode.scopeDigest !== exactScopeDigest) {
      throw invalid("schema.corrupt", "evidence reference scope does not match execution scope", [
        ...path,
        "evidenceRefs",
        index,
        "episode",
        "scopeDigest",
      ]);
    }
    if (reference.loopRegistryRevision !== loopRegistryRevision) {
      throw invalid("schema.corrupt", "evidence reference belongs to another loop registry revision", [
        ...path,
        "evidenceRefs",
        index,
        "loopRegistryRevision",
      ]);
    }
    if (!profileSourceRevisions.has(canonicalKey([reference.sourceId, reference.sourceRegistrationRevision]))) {
      throw invalid("schema.corrupt", "evidence reference has no exact source semantic profile", [
        ...path,
        "evidenceRefs",
        index,
      ]);
    }
  }

  const evidenceHealthFindings = fields.req("evidenceHealthFindings", parseEvidenceHealthFindingsAt);
  assertFindingSources(evidenceHealthFindings, sourceProfiles, [...path, "evidenceHealthFindings"]);
  const availableCapabilities = fields.req(
    "availableCapabilities",
    parseBoundedArray(parseId, MAX_SET_VALUES, "available capabilities"),
  );
  assertSortedUnique(availableCapabilities, (value) => value, [...path, "availableCapabilities"]);
  if (!sameTexts(availableCapabilities, exactAvailableCapabilities(sourceProfiles))) {
    throw invalid("schema.corrupt", "available capabilities do not match the exact source-profile union", [
      ...path,
      "availableCapabilities",
    ]);
  }

  const base = {
    sourceProfiles,
    population,
    evidenceRefs,
    evidenceHealthFindings,
    availableCapabilities,
  };
  const windowDigest = fields.req("windowDigest", parseDigestAt);
  if (windowDigest !== digestOf(base)) {
    throw invalid("schema.corrupt", "execution window digest does not match its bound fields", [
      ...path,
      "windowDigest",
    ]);
  }
  return { ...base, windowDigest };
}

function parseDerivationRefAt(input: unknown, path: readonly (string | number)[]): DetectorExecutionDerivationRef {
  const fields = readFields(input, path);
  const id = fields.req("id", parseDurableId);
  const derivationDigest = fields.req("derivationDigest", parseDigestAt);
  if (!INSIGHT_ID_PATTERN.test(id) || id !== `insight-${derivationDigest}`) {
    throw invalid("schema.corrupt", "insight id does not match its derivation digest", [...path, "id"]);
  }
  return {
    id,
    derivationDigest,
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
  };
}

function parseAppliedResultAt(
  fields: ReturnType<typeof readFields>,
  path: readonly (string | number)[],
  outputKind: DetectorOutputKind,
  exactScopeDigest: string,
  sourceProfiles: readonly SourceSemanticProfile[],
): Extract<DetectorExecutionResult, { readonly status: "applied" }> {
  const conditionDetected = fields.req("conditionDetected", parseBool);
  const derivationRefs = fields.req(
    "derivationRefs",
    parseBoundedArray(parseDerivationRefAt, MAX_SET_VALUES, "derivation references"),
  );
  assertSortedUnique(derivationRefs, (reference) => canonicalKey([reference.id, reference.derivationDigest]), [
    ...path,
    "derivationRefs",
  ]);
  const derivationIds = new Set<string>();
  const derivationDigests = new Set<string>();
  for (const [index, reference] of derivationRefs.entries()) {
    if (reference.scopeDigest !== exactScopeDigest) {
      throw invalid("schema.corrupt", "derivation reference scope does not match execution scope", [
        ...path,
        "derivationRefs",
        index,
        "scopeDigest",
      ]);
    }
    if (derivationIds.has(reference.id) || derivationDigests.has(reference.derivationDigest)) {
      throw invalid("schema.invalid", "derivation references may be included only once", [
        ...path,
        "derivationRefs",
        index,
      ]);
    }
    derivationIds.add(reference.id);
    derivationDigests.add(reference.derivationDigest);
  }
  const evidenceHealthFindings = fields.req("evidenceHealthFindings", parseEvidenceHealthFindingsAt);
  assertFindingSources(evidenceHealthFindings, sourceProfiles, [...path, "evidenceHealthFindings"]);

  if (!conditionDetected && (derivationRefs.length !== 0 || evidenceHealthFindings.length !== 0)) {
    throw invalid("schema.invalid", "an applied negative condition cannot carry detector outputs", path);
  }
  if (conditionDetected && outputKind === "insight_derivation") {
    if (derivationRefs.length === 0 || evidenceHealthFindings.length !== 0) {
      throw invalid("schema.invalid", "a detected insight condition requires only derivation outputs", path);
    }
  }
  if (conditionDetected && outputKind === "evidence_health") {
    if (evidenceHealthFindings.length === 0 || derivationRefs.length !== 0) {
      throw invalid("schema.invalid", "a detected evidence-health condition requires only health findings", path);
    }
  }
  return { status: "applied", conditionDetected, derivationRefs, evidenceHealthFindings };
}

function parseNonAppliedResultAt(
  status: Exclude<DetectorExecutionStatus, "applied">,
  fields: ReturnType<typeof readFields>,
  path: readonly (string | number)[],
  availableCapabilities: readonly string[],
): Extract<DetectorExecutionResult, { readonly status: "not_applicable" | "incomplete" }> {
  const reasonCodes = fields.req("reasonCodes", parseBoundedArray(parseId, MAX_SET_VALUES, "reason codes"));
  if (reasonCodes.length === 0) {
    throw invalid("schema.invalid", "a non-applied detector result requires a reason code", [...path, "reasonCodes"]);
  }
  assertSortedUnique(reasonCodes, (value) => value, [...path, "reasonCodes"]);
  const missingCapabilities = fields.req(
    "missingCapabilities",
    parseBoundedArray(parseId, MAX_SET_VALUES, "missing capabilities"),
  );
  assertSortedUnique(missingCapabilities, (value) => value, [...path, "missingCapabilities"]);
  const available = new Set(availableCapabilities);
  for (const [index, capability] of missingCapabilities.entries()) {
    if (available.has(capability)) {
      throw invalid("schema.corrupt", "a capability cannot be both available and missing", [
        ...path,
        "missingCapabilities",
        index,
      ]);
    }
  }
  return { status, reasonCodes, missingCapabilities };
}

function parseExecutionResultAt(
  input: unknown,
  path: readonly (string | number)[],
  outputKind: DetectorOutputKind,
  exactScopeDigest: string,
  availableCapabilities: readonly string[],
  sourceProfiles: readonly SourceSemanticProfile[],
): DetectorExecutionResult {
  const fields = readFields(input, path);
  const status = fields.req("status", parseOneOf(DETECTOR_EXECUTION_STATUSES));
  if (status === "applied") return parseAppliedResultAt(fields, path, outputKind, exactScopeDigest, sourceProfiles);
  return parseNonAppliedResultAt(status, fields, path, availableCapabilities);
}

export function parseDetectorExecutionRecord(input: unknown): DetectorExecutionRecord {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const loopRegistryRevision = fields.req("loopRegistryRevision", parseDigestAt);
  const rawDetector = fields.req("detector", (value) => value);
  const detectorFields = readFields(rawDetector, ["detector"]);
  const detector = {
    ...parseDetectorRefAt(rawDetector, ["detector"]),
    configurationDigest: detectorFields.req("configurationDigest", parseDigestAt),
    implementationDigest: detectorFields.req("implementationDigest", parseDigestAt),
  };
  const pack = fields.req("pack", parsePackRefAt);
  const lens = fields.req("lens", parseNullable(parseLensRefAt));
  const scope = fields.req("scope", parseScopeAt);
  const exactScopeDigest = fields.req("scopeDigest", parseDigestAt);
  if (exactScopeDigest !== scopeDigest(scope)) {
    throw invalid("schema.corrupt", "execution scope digest does not match its exact scope", ["scopeDigest"]);
  }
  const scopePolicyDigest = fields.req("scopePolicyDigest", parseDigestAt);
  const outputKind = fields.req("outputKind", parseOneOf(DETECTOR_OUTPUT_KINDS));
  if (outputKind === "insight_derivation" && lens === null) {
    throw invalid("schema.invalid", "insight derivation execution requires an exact learning lens", ["lens"]);
  }
  if (outputKind === "evidence_health" && lens !== null) {
    throw invalid("schema.invalid", "evidence-health execution must remain lens-independent", ["lens"]);
  }
  const window = fields.req("window", (value, path) =>
    parseExecutionWindowAt(value, path, exactScopeDigest, loopRegistryRevision),
  );
  const result = fields.req("result", (value, path) =>
    parseExecutionResultAt(
      value,
      path,
      outputKind,
      exactScopeDigest,
      window.availableCapabilities,
      window.sourceProfiles,
    ),
  );
  const base = {
    loopRegistryRevision,
    detector,
    pack,
    lens,
    scope,
    scopeDigest: exactScopeDigest,
    scopePolicyDigest,
    outputKind,
    window,
  };
  const executionKeyDigest = fields.req("executionKeyDigest", parseDigestAt);
  if (executionKeyDigest !== detectorExecutionKeyDigest(base)) {
    throw invalid("schema.corrupt", "detector execution key digest does not match its invocation and window", [
      "executionKeyDigest",
    ]);
  }
  const id = fields.req("id", parseDurableId);
  if (!DETECTOR_EXECUTION_ID_PATTERN.test(id) || id !== `detector-execution-${executionKeyDigest}`) {
    throw invalid("schema.corrupt", "detector execution id does not match its execution key digest", ["id"]);
  }
  const executionDigest = fields.req("executionDigest", parseDigestAt);
  const execution: DetectorExecutionRecord = {
    schemaVersion,
    id,
    ...base,
    result,
    executionKeyDigest,
    executionDigest,
  };
  if (executionDigest !== detectorExecutionDigest({ ...base, result, executionKeyDigest })) {
    throw invalid("schema.corrupt", "detector execution digest does not match its bound fields", ["executionDigest"]);
  }
  return execution;
}
