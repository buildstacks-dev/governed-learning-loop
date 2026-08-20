// Atomic ownership for one durable derivative's unique source-page commit
// marker. The claim is written before the derivative record, so concurrent
// different pages cannot both publish receipts containing the same tuple.
import { sha256HexOfCanonicalJson } from "../canonical/canonical-json.js";
import { toJsonValue } from "../canonical/to-json-value.js";
import { invalid, parseNonEmptyText, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import type { SourcePageReceipt, SourcePageState } from "../records/source-health.js";
import { parseSourcePageStateAt } from "../records/source-health.js";
import type { EngineContext } from "./context.js";
import { createOnly, loadStoredRecord } from "./context.js";

const DERIVATIVE_KINDS = ["observation", "measurement", "episode"] as const;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

export interface DerivativePageOwner {
  readonly sourceId: string;
  readonly sourceRegistrationRevision: string;
  readonly contentPolicyId: string;
  readonly contentPolicyDigest: string;
  readonly loopRegistryRevision: string;
  readonly sourceRef: string;
  readonly pageRef: string;
  readonly state: SourcePageState;
}

interface DerivativeOwnerClaim {
  readonly schemaVersion: 1;
  readonly derivative: SourcePageReceipt["derivatives"][number];
  readonly owner: DerivativePageOwner;
  readonly ownerDigest: string;
  readonly claimDigest: string;
}

const parseDigestAt: Parse<string> = (input, path) => {
  const digest = parseNonEmptyText(input, path);
  if (!DIGEST_PATTERN.test(digest)) throw invalid("schema.invalid", "expected a lowercase SHA-256 digest", path);
  return digest;
};

const parseDerivativeAt: Parse<DerivativeOwnerClaim["derivative"]> = (input, path) => {
  const fields = readFields(input, path);
  return {
    kind: fields.req("kind", parseOneOf(DERIVATIVE_KINDS)),
    id: fields.req("id", parseNonEmptyText),
    digest: fields.req("digest", parseDigestAt),
  };
};

const parseOwnerAt: Parse<DerivativePageOwner> = (input, path) => {
  const fields = readFields(input, path);
  return {
    sourceId: fields.req("sourceId", parseNonEmptyText),
    sourceRegistrationRevision: fields.req("sourceRegistrationRevision", parseDigestAt),
    contentPolicyId: fields.req("contentPolicyId", parseNonEmptyText),
    contentPolicyDigest: fields.req("contentPolicyDigest", parseDigestAt),
    loopRegistryRevision: fields.req("loopRegistryRevision", parseDigestAt),
    sourceRef: fields.req("sourceRef", parseNonEmptyText),
    pageRef: fields.req("pageRef", parseNonEmptyText),
    state: fields.req("state", parseSourcePageStateAt),
  };
};

function ownerDigest(owner: DerivativePageOwner): string {
  return sha256HexOfCanonicalJson(toJsonValue(owner));
}

function claimDigest(input: Omit<DerivativeOwnerClaim, "schemaVersion" | "claimDigest">): string {
  return sha256HexOfCanonicalJson(
    toJsonValue({ derivative: input.derivative, owner: input.owner, ownerDigest: input.ownerDigest }),
  );
}

function parseClaim(input: unknown): DerivativeOwnerClaim {
  const fields = readFields(input, []);
  const claim: DerivativeOwnerClaim = {
    schemaVersion: fields.schemaVersion1(),
    derivative: fields.req("derivative", parseDerivativeAt),
    owner: fields.req("owner", parseOwnerAt),
    ownerDigest: fields.req("ownerDigest", parseDigestAt),
    claimDigest: fields.req("claimDigest", parseDigestAt),
  };
  if (claim.ownerDigest !== ownerDigest(claim.owner) || claim.claimDigest !== claimDigest(claim)) {
    throw invalid("schema.corrupt", "derivative owner claim digest does not match its content", ["claimDigest"]);
  }
  return claim;
}

function ownerFromReceipt(receipt: SourcePageReceipt): DerivativePageOwner {
  return {
    sourceId: receipt.sourceId,
    sourceRegistrationRevision: receipt.sourceRegistrationRevision,
    contentPolicyId: receipt.contentPolicyId,
    contentPolicyDigest: receipt.contentPolicyDigest,
    loopRegistryRevision: receipt.loopRegistryRevision,
    sourceRef: receipt.sourceRef,
    pageRef: receipt.pageRef,
    state: receipt.state,
  };
}

function derivativeClaimId(derivative: SourcePageReceipt["derivatives"][number]): string {
  return sha256HexOfCanonicalJson(toJsonValue(derivative));
}

/** Returns owned for the exact owner page, reused when another page owns it. */
export async function claimDerivativePage(
  context: EngineContext,
  derivative: SourcePageReceipt["derivatives"][number],
  currentOwner: DerivativePageOwner,
  existingReceipt: SourcePageReceipt | undefined,
): Promise<"owned" | "reused"> {
  const owner = existingReceipt === undefined ? currentOwner : ownerFromReceipt(existingReceipt);
  const bound = { derivative, owner, ownerDigest: ownerDigest(owner) };
  const claim: DerivativeOwnerClaim = {
    schemaVersion: 1,
    ...bound,
    claimDigest: claimDigest(bound),
  };
  const id = derivativeClaimId(derivative);
  await createOnly(context, "derivative-owner", id, claim, `derivative-owner/${id}`);
  const stored = await loadStoredRecord(context, "derivative-owner", id);
  if (stored === undefined) {
    throw invalid("store.corrupt", "derivative owner claim disappeared after create", ["derivativeOwner"]);
  }
  const committed = parseClaim(stored.value);
  if (
    committed.derivative.kind !== derivative.kind ||
    committed.derivative.id !== derivative.id ||
    committed.derivative.digest !== derivative.digest
  ) {
    throw invalid("store.corrupt", "derivative owner claim belongs to another derivative", ["derivative"]);
  }
  if (existingReceipt !== undefined && committed.ownerDigest !== ownerDigest(ownerFromReceipt(existingReceipt))) {
    throw invalid("store.corrupt", "derivative owner claim conflicts with its committed source page", ["owner"]);
  }
  return committed.ownerDigest === ownerDigest(currentOwner) ? "owned" : "reused";
}
