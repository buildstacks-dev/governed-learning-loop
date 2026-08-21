import { canonicalJsonText, sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText, readFields } from "../parse/toolkit.js";
import type { Candidate } from "../records/candidate.js";
import { parseDigestAt, parseDurableId, scopeDigest } from "../records/semantic-shared.js";
import type { EngineContext } from "./context.js";
import { parseWriteResult, recordDigest } from "./context.js";

const KIND = "candidate-scope-index";
const DOMAIN = "candidate-scope-membership:v1";

export interface CandidateScopeMembership {
  readonly schemaVersion: 1;
  readonly scopeDigest: string;
  readonly candidateId: string;
  readonly candidateDigest: string;
  readonly indexDigest: string;
}

function namespace(exactScopeDigest: string): string {
  return `learning-candidate-scope-${exactScopeDigest}`;
}

function content(input: Omit<CandidateScopeMembership, "schemaVersion" | "indexDigest">) {
  return { domain: DOMAIN, ...input };
}

export function parseCandidateScopeMembership(input: unknown): CandidateScopeMembership {
  const fields = readFields(input, []);
  const schemaVersion = fields.schemaVersion1();
  const base = {
    scopeDigest: fields.req("scopeDigest", parseDigestAt),
    candidateId: fields.req("candidateId", parseDurableId),
    candidateDigest: fields.req("candidateDigest", parseDigestAt),
  };
  const indexDigest = fields.req("indexDigest", parseDigestAt);
  if (indexDigest !== sha256HexOfCanonicalJson(toJsonValue(content(base)))) {
    throw invalid("schema.corrupt", "Candidate scope membership digest is invalid", ["indexDigest"]);
  }
  return Object.freeze({ schemaVersion, ...base, indexDigest });
}

export function buildCandidateScopeMembership(candidate: Candidate): CandidateScopeMembership {
  const base = {
    scopeDigest: scopeDigest(candidate.scope),
    candidateId: candidate.id,
    candidateDigest: candidate.contentDigest,
  };
  return parseCandidateScopeMembership({
    schemaVersion: 1,
    ...base,
    indexDigest: sha256HexOfCanonicalJson(toJsonValue(content(base))),
  });
}

function parseStored(input: unknown, expected: { readonly scopeDigest: string; readonly candidateId: string }) {
  const fields = readFields(input, ["store", "candidateScopeMembership"]);
  const keyFields = readFields(
    fields.req("key", (value) => value),
    ["store", "candidateScopeMembership", "key"],
  );
  const value = fields.req("value", (record) => record);
  const digest = fields.req("digest", parseNonEmptyText);
  if (
    keyFields.req("namespace", parseNonEmptyText) !== namespace(expected.scopeDigest) ||
    keyFields.req("kind", parseNonEmptyText) !== KIND ||
    keyFields.req("id", parseNonEmptyText) !== expected.candidateId ||
    digest !== recordDigest(toJsonValue(value))
  ) {
    throw invalid("store.corrupt", "Candidate scope membership envelope is invalid", []);
  }
  const membership = parseCandidateScopeMembership(value);
  if (
    membership.scopeDigest !== expected.scopeDigest ||
    membership.candidateId !== expected.candidateId ||
    canonicalJsonText(toJsonValue(membership)) !== canonicalJsonText(toJsonValue(value))
  ) {
    throw invalid("store.corrupt", "Candidate scope membership belongs to another target", []);
  }
  return membership;
}

export async function loadCandidateScopeMembership(
  context: EngineContext,
  input: { readonly scopeDigest: string; readonly candidateId: string },
): Promise<CandidateScopeMembership | undefined> {
  const raw: unknown = await context.store.get({
    namespace: namespace(input.scopeDigest),
    kind: KIND,
    id: input.candidateId,
  });
  return raw === undefined ? undefined : parseStored(raw, input);
}

export async function persistCandidateScopeMembership(context: EngineContext, candidate: Candidate): Promise<void> {
  const membership = buildCandidateScopeMembership(candidate);
  const value = toJsonValue(membership);
  const raw: unknown = await context.store.create(
    { namespace: namespace(membership.scopeDigest), kind: KIND, id: membership.candidateId },
    value,
    recordDigest(value),
    `candidate-scope/${membership.scopeDigest}/${membership.candidateId}/${membership.indexDigest}`,
  );
  const result = parseWriteResult(raw);
  if (result.status === "updated") throw invalid("store.corrupt", "Candidate scope membership was updated", []);
  if (result.status === "conflict") throw invalid("store.conflict", "Candidate scope membership conflicts", []);
  const stored = await loadCandidateScopeMembership(context, membership);
  if (stored?.indexDigest !== membership.indexDigest || stored.candidateDigest !== membership.candidateDigest) {
    throw invalid("store.corrupt", "Candidate scope membership was not preserved", []);
  }
}
