// Context resolution receipt (contract §The façade `ResolvedContext`,
// §Intervention, exposure, and efficacy; decision 0027). A resolution freezes
// the exact content the kernel served for one future episode: every entry
// binds the exact active intervention (and therefore its plan digest,
// candidate digest, and state head at resolution time) together with the
// content bytes and their digest, and the receipt binds the exact scope, the
// loop scope policy, registry revision, learning policy, the caller's query
// digest, the budget, and every intervention the budget omitted. The receipt
// is content-addressed (`resolution-<receiptDigest>`) over everything except
// its timestamp, so resolving the same episode against the same active set
// is idempotent and a mid-run publication cannot change treatment. Holding a
// receipt grants nothing: a candidate never resolves (kernel invariant 1),
// and only an exposure acknowledged with host-observed evidence is lineage.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import type { JsonValue } from "../canonical/json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseJson, readFields } from "../parse/toolkit.js";
import type { Parse, ParsePath } from "../parse/toolkit.js";
import { parseScopeShapeAt } from "./episode.js";
import type { Scope } from "./scope.js";
import {
  parseBoundedArray,
  parseCanonicalTimestampAt,
  parseDigestAt,
  parseDurableId,
  parseId,
  scopeDigest,
} from "./semantic-shared.js";

export interface ResolvedEntry {
  readonly id: string;
  readonly interventionId: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly planDigest: string;
  readonly destinationId: string;
  readonly scopeDigest: string;
  readonly transitionId: string;
  readonly content: JsonValue;
  readonly contentDigest: string;
}

export interface ResolvedContext {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly episodeId: string;
  readonly scope: Scope;
  readonly scopeDigest: string;
  readonly scopePolicyDigest: string;
  readonly registryRevision: string;
  readonly policyDigest: string;
  readonly queryDigest: string;
  readonly budget: {
    readonly maximumEntries: number;
    readonly maximumCharacters: number;
  };
  readonly entries: readonly ResolvedEntry[];
  readonly omittedInterventionIds: readonly string[];
  readonly resolvedAt: string;
  readonly receiptDigest: string;
}

/** Hard ceiling on entries one resolution may serve; a larger budget is refused, never clamped. */
export const MAX_RESOLUTION_ENTRIES = 1_000;
/** Hard ceiling on the character budget of one resolution. */
export const MAX_RESOLUTION_CHARACTERS = 10_000_000;
/** Hard ceiling on the canonical characters of a caller query; larger queries fail closed. */
export const MAX_RESOLUTION_QUERY_CHARACTERS = 100_000;
/** Omitted interventions are bounded by the scope-membership ceiling of the publication journal. */
export const MAX_OMITTED_INTERVENTIONS = 10_000;

const RECEIPT_DIGEST_DOMAIN = "context-resolution:v1";
const ENTRY_DIGEST_DOMAIN = "context-resolution-entry:v1";
const QUERY_DIGEST_DOMAIN = "context-resolution-query:v1";
const RECEIPT_ID_PREFIX = "resolution-";
const ENTRY_ID_PREFIX = "entry-";
const INTERVENTION_ID_PREFIX = "intervention-";
const TRANSITION_ID_PREFIX = "transition-";

export type ResolutionBudgetInput = ResolvedContext["budget"];

function parseBudgetInteger(maximum: number, label: string): Parse<number> {
  return (input, path) => {
    if (typeof input !== "number" || !Number.isSafeInteger(input) || input < 1 || input > maximum) {
      throw invalid("schema.invalid", `${label} must be an integer between 1 and ${maximum}`, path);
    }
    return input;
  };
}

export const parseResolutionBudgetAt: Parse<ResolvedContext["budget"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    maximumEntries: fields.req("maximumEntries", parseBudgetInteger(MAX_RESOLUTION_ENTRIES, "maximumEntries")),
    maximumCharacters: fields.req(
      "maximumCharacters",
      parseBudgetInteger(MAX_RESOLUTION_CHARACTERS, "maximumCharacters"),
    ),
  };
};

/** The caller query enters the receipt only as a domain-tagged digest; its text never persists. */
export function resolutionQueryDigest(query: JsonValue): string {
  return sha256HexOfCanonicalJson({ domain: QUERY_DIGEST_DOMAIN, query });
}

/** Entry id: the exact intervention, its state head at resolution, and the served content digest. */
export function resolvedEntryIdFor(input: {
  readonly interventionId: string;
  readonly transitionId: string;
  readonly contentDigest: string;
}): string {
  return `${ENTRY_ID_PREFIX}${sha256HexOfCanonicalJson({
    domain: ENTRY_DIGEST_DOMAIN,
    interventionId: input.interventionId,
    transitionId: input.transitionId,
    contentDigest: input.contentDigest,
  })}`;
}

function entryContent(entry: ResolvedEntry): JsonValue {
  return toJsonValue({
    id: entry.id,
    interventionId: entry.interventionId,
    candidateId: entry.candidateId,
    candidateDigest: entry.candidateDigest,
    planDigest: entry.planDigest,
    destinationId: entry.destinationId,
    scopeDigest: entry.scopeDigest,
    transitionId: entry.transitionId,
    content: entry.content,
    contentDigest: entry.contentDigest,
  });
}

/**
 * Receipt digest: episode, exact scope and its digest, scope policy digest,
 * registry revision, policy digest, query digest, budget, every entry in
 * order, and every omitted intervention id, under a domain-separation tag.
 * Excludes schemaVersion, id, resolvedAt, and receiptDigest.
 */
export function resolvedContextDigest(
  input: Omit<ResolvedContext, "schemaVersion" | "id" | "resolvedAt" | "receiptDigest">,
): string {
  return sha256HexOfCanonicalJson({
    domain: RECEIPT_DIGEST_DOMAIN,
    episodeId: input.episodeId,
    scope: input.scope.map((segment) => ({ type: segment.type, id: segment.id })),
    scopeDigest: input.scopeDigest,
    scopePolicyDigest: input.scopePolicyDigest,
    registryRevision: input.registryRevision,
    policyDigest: input.policyDigest,
    queryDigest: input.queryDigest,
    budget: { maximumEntries: input.budget.maximumEntries, maximumCharacters: input.budget.maximumCharacters },
    entries: input.entries.map(entryContent),
    omittedInterventionIds: [...input.omittedInterventionIds],
  });
}

/** Content-addressed receipt id: the resolution is its digest. */
export function resolvedContextIdFor(receiptDigest: string): string {
  return `${RECEIPT_ID_PREFIX}${receiptDigest}`;
}

/** The receipt digest a `resolution-<digest>` id carries, or undefined for any other shape. */
export function receiptDigestOfResolutionId(id: string): string | undefined {
  if (!id.startsWith(RECEIPT_ID_PREFIX)) return undefined;
  const digest = id.slice(RECEIPT_ID_PREFIX.length);
  return /^[0-9a-f]{64}$/.test(digest) ? digest : undefined;
}

const parsePrefixedDigestId =
  (prefix: string, label: string): Parse<string> =>
  (input, path) => {
    const id = parseDurableId(input, path);
    if (!id.startsWith(prefix) || !/^[0-9a-f]{64}$/.test(id.slice(prefix.length))) {
      throw invalid("schema.invalid", `${label} must be ${prefix}<sha-256 hex>`, path);
    }
    return id;
  };

const parseInterventionIdAt = parsePrefixedDigestId(INTERVENTION_ID_PREFIX, "intervention id");
const parseTransitionIdAt = parsePrefixedDigestId(TRANSITION_ID_PREFIX, "transition id");

export const parseResolvedEntryAt: Parse<ResolvedEntry> = (input, path) => {
  const fields = readFields(input, path);
  const interventionId = fields.req("interventionId", parseInterventionIdAt);
  const planDigest = fields.req("planDigest", parseDigestAt);
  if (interventionId !== `${INTERVENTION_ID_PREFIX}${planDigest}`) {
    throw invalid("schema.corrupt", "resolved entry intervention id does not match its plan digest", [
      ...path,
      "interventionId",
    ]);
  }
  const content = fields.req("content", parseJson);
  const contentDigest = fields.req("contentDigest", parseDigestAt);
  if (contentDigest !== sha256HexOfCanonicalJson(content)) {
    throw invalid("schema.corrupt", "resolved entry contentDigest does not match its canonical content", [
      ...path,
      "contentDigest",
    ]);
  }
  const transitionId = fields.req("transitionId", parseTransitionIdAt);
  const id = fields.req("id", parseDurableId);
  if (id !== resolvedEntryIdFor({ interventionId, transitionId, contentDigest })) {
    throw invalid("schema.corrupt", "resolved entry id does not match its bound fields", [...path, "id"]);
  }
  return {
    id,
    interventionId,
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
    planDigest,
    destinationId: fields.req("destinationId", parseId),
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    transitionId,
    content,
    contentDigest,
  };
};

function assertUniqueEntries(entries: readonly ResolvedEntry[], path: ParsePath): void {
  const ids = new Set<string>();
  const interventions = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    if (ids.has(entry.id)) throw invalid("schema.invalid", "resolved entry ids must be unique", [...path, index, "id"]);
    if (interventions.has(entry.interventionId)) {
      throw invalid("schema.invalid", "a resolution serves each intervention at most once", [
        ...path,
        index,
        "interventionId",
      ]);
    }
    ids.add(entry.id);
    interventions.add(entry.interventionId);
  }
}

/**
 * Unknown-first parser. Recomputes the scope digest, every entry id and
 * content digest, the receipt digest, and the content-addressed id; refuses
 * duplicate or over-budget entries and an omitted id that is also served.
 */
export function parseResolvedContext(input: unknown): ResolvedContext {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const scope = fields.req("scope", parseScopeShapeAt);
  if (scope.length === 0) throw invalid("schema.invalid", "a resolution requires a non-empty scope", ["scope"]);
  const boundScopeDigest = fields.req("scopeDigest", parseDigestAt);
  if (boundScopeDigest !== scopeDigest(scope)) {
    throw invalid("schema.corrupt", "resolution scopeDigest does not match its scope", ["scopeDigest"]);
  }
  const budget = fields.req("budget", parseResolutionBudgetAt);
  const entries = fields.req(
    "entries",
    parseBoundedArray(parseResolvedEntryAt, MAX_RESOLUTION_ENTRIES, "resolved entries"),
  );
  assertUniqueEntries(entries, ["entries"]);
  if (entries.length > budget.maximumEntries) {
    throw invalid("schema.invalid", "a resolution cannot serve more entries than its budget", ["entries"]);
  }
  const omittedInterventionIds = fields.req(
    "omittedInterventionIds",
    parseBoundedArray(parseInterventionIdAt, MAX_OMITTED_INTERVENTIONS, "omitted interventions"),
  );
  const served = new Set(entries.map((entry) => entry.interventionId));
  const omitted = new Set<string>();
  for (const [index, id] of omittedInterventionIds.entries()) {
    if (served.has(id) || omitted.has(id)) {
      throw invalid("schema.invalid", "an omitted intervention must be unique and not served", [
        "omittedInterventionIds",
        index,
      ]);
    }
    omitted.add(id);
  }
  const content = {
    episodeId: fields.req("episodeId", parseDurableId),
    scope,
    scopeDigest: boundScopeDigest,
    scopePolicyDigest: fields.req("scopePolicyDigest", parseDigestAt),
    registryRevision: fields.req("registryRevision", parseDigestAt),
    policyDigest: fields.req("policyDigest", parseDigestAt),
    queryDigest: fields.req("queryDigest", parseDigestAt),
    budget,
    entries,
    omittedInterventionIds,
  };
  const receiptDigest = fields.req("receiptDigest", parseDigestAt);
  if (receiptDigest !== resolvedContextDigest(content)) {
    throw invalid("schema.corrupt", "resolution receiptDigest does not match its bound fields", ["receiptDigest"]);
  }
  const id = fields.req("id", parseDurableId);
  if (id !== resolvedContextIdFor(receiptDigest)) {
    throw invalid("schema.corrupt", "resolution id does not match its receipt digest", ["id"]);
  }
  const resolvedAt = fields.req("resolvedAt", parseCanonicalTimestampAt);
  return { schemaVersion, id, ...content, resolvedAt, receiptDigest };
}
