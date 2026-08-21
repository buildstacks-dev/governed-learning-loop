// Executable transcript privacy policy (decision 0024). The policy is
// content-addressed: `policyDigest` is the SHA-256 of the canonical JSON of
// every other field except `schemaVersion`. Adapters declare `{ id, digest }`
// to the kernel through their SourceDescriptor, and the kernel binds that
// declaration into the source registration revision and into every page and
// import receipt — so the exact policy that governed an import is durable and
// audit-visible, and changed policy content changes every receipt.
//
// The policy carries NO private values (no paths, keys, tenants, session ids)
// by construction, so its plain unkeyed digest is safe to persist. Closed
// literals are enforced by the parser: any value other than the single
// admitted one is refused, which means home-directory discovery, symlink
// following, decompression, raw-content persistence, unkeyed identities, and
// outbound model calls cannot be enabled through policy content in this schema
// version — only an explicit new schema version could admit them. Numeric
// ceilings may only tighten the shipped maxima in ./limits.ts.
import { sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";
import { LearningLoopError } from "@cormidia/learning-loop";
import {
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_NESTING_DEPTH,
  MAX_PROCESSING_MILLIS_PER_FILE,
  MAX_RECORDS_PER_FILE,
} from "./limits.js";
import { isRecord } from "./narrow.js";

export interface TranscriptPrivacyPolicy {
  readonly schemaVersion: 1;
  /** Host-chosen policy identifier; bounded, control-free, no "/" (it is bound into receipts). */
  readonly id: string;
  readonly version: string;
  readonly input: {
    /** The caller enumerates files; there is no discovery mechanism to enable. */
    readonly mechanism: "explicit_files";
    readonly discovery: "forbidden";
    readonly access: "read_only";
    /** Final-component and intermediate-directory symlinks are refused; links are never followed. */
    readonly symlinks: "refuse";
    /** `required`: every call declares `roots` and every path must resolve inside one. */
    readonly rootConfinement: "required" | "optional";
  };
  readonly ceilings: {
    readonly maximumFileBytes: number;
    readonly maximumLineBytes: number;
    readonly maximumRecordsPerFile: number;
    readonly maximumNestingDepth: number;
    readonly maximumProcessingMillisPerFile: number;
  };
  readonly decoding: {
    /** Compressed or binary input is refused before any decoding; nothing is ever inflated. */
    readonly compressedInput: "refuse";
  };
  readonly persistence: {
    readonly rawContent: "never";
    readonly messageText: "structural_features_only";
    readonly privateIdentities: "tenant_keyed";
    readonly diagnostics: "static_codes_only";
  };
  readonly recurrence: {
    /** Byte-identical native records inside one file project once, never as independent recurrence. */
    readonly duplicateSegments: "collapse";
  };
  readonly outbound: {
    readonly modelCalls: "forbidden";
  };
  readonly publication: {
    readonly derivedArtifacts: "private";
  };
  readonly processingBasis: {
    readonly classification: "sensitive_untrusted";
    readonly basis: "explicit_user_selection";
    readonly trustMaximum: "advisory";
  };
  /**
   * Declared and digested, but NOT yet enforced: the kernel has no deletion or
   * consent-revocation lineage API (decision 0004 defers it to issue #31). A
   * host records its intended disposition here so the commitment is bound
   * into receipts before the mechanism exists.
   */
  readonly disposition: {
    readonly onSourceDeletion: "tombstone_and_refuse" | "retain_under_basis" | "queue_human_disposition";
    readonly onConsentRevocation: "tombstone_and_refuse" | "queue_human_disposition";
  };
  readonly policyDigest: string;
}

type PolicyContent = Omit<TranscriptPrivacyPolicy, "schemaVersion" | "policyDigest">;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 200;
const SEMVER_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;

function policyError(message: string, path: readonly (string | number)[], code = "schema.invalid"): LearningLoopError {
  return new LearningLoopError(code, [{ code, severity: "error", message, path }]);
}

function readRecord(input: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  if (!isRecord(input)) throw policyError("expected an object", path);
  return input;
}

function readLiteral<T extends string>(
  record: Record<string, unknown>,
  key: string,
  admitted: readonly T[],
  path: readonly (string | number)[],
): T {
  const value = record[key];
  for (const candidate of admitted) {
    if (value === candidate) return candidate;
  }
  throw policyError(
    `${key} must be ${admitted.map((candidate) => JSON.stringify(candidate)).join(" | ")}; this schema version admits nothing else`,
    [...path, key],
  );
}

function readCeiling(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  path: readonly (string | number)[],
): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw policyError(`${key} must be an integer from 1 through the shipped maximum ${maximum}`, [...path, key]);
  }
  return value;
}

function readId(record: Record<string, unknown>, path: readonly (string | number)[]): string {
  const value = record.id;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ID_LENGTH) {
    throw policyError(`id must be a non-empty string of at most ${MAX_ID_LENGTH} characters`, [...path, "id"]);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || character === "/") {
      throw policyError("id must not contain control characters or '/'", [...path, "id"]);
    }
  }
  return value;
}

function readVersion(record: Record<string, unknown>, path: readonly (string | number)[]): string {
  const value = record.version;
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw policyError("version must be a semantic version string", [...path, "version"]);
  }
  return value;
}

function policyContent(policy: PolicyContent): PolicyContent {
  return {
    id: policy.id,
    version: policy.version,
    input: { ...policy.input },
    ceilings: { ...policy.ceilings },
    decoding: { ...policy.decoding },
    persistence: { ...policy.persistence },
    recurrence: { ...policy.recurrence },
    outbound: { ...policy.outbound },
    publication: { ...policy.publication },
    processingBasis: { ...policy.processingBasis },
    disposition: { ...policy.disposition },
  };
}

/** SHA-256 over the canonical JSON of every field except `schemaVersion` and `policyDigest`. */
export function transcriptPrivacyPolicyDigest(policy: PolicyContent): string {
  return sha256HexOfCanonicalJson(toJsonValue(policyContent(policy)));
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** Parses a policy from `unknown`, enforcing closed literals, tightened ceilings, and the content digest. */
export function parseTranscriptPrivacyPolicy(input: unknown): TranscriptPrivacyPolicy {
  const record = readRecord(input, []);
  if (record.schemaVersion !== 1) {
    throw policyError(
      "unsupported schemaVersion; this parser accepts schemaVersion 1",
      ["schemaVersion"],
      "schema.unsupported_version",
    );
  }
  const inputRules = readRecord(record.input, ["input"]);
  const ceilings = readRecord(record.ceilings, ["ceilings"]);
  const decoding = readRecord(record.decoding, ["decoding"]);
  const persistence = readRecord(record.persistence, ["persistence"]);
  const recurrence = readRecord(record.recurrence, ["recurrence"]);
  const outbound = readRecord(record.outbound, ["outbound"]);
  const publication = readRecord(record.publication, ["publication"]);
  const processingBasis = readRecord(record.processingBasis, ["processingBasis"]);
  const disposition = readRecord(record.disposition, ["disposition"]);
  const content: PolicyContent = {
    id: readId(record, []),
    version: readVersion(record, []),
    input: {
      mechanism: readLiteral(inputRules, "mechanism", ["explicit_files"], ["input"]),
      discovery: readLiteral(inputRules, "discovery", ["forbidden"], ["input"]),
      access: readLiteral(inputRules, "access", ["read_only"], ["input"]),
      symlinks: readLiteral(inputRules, "symlinks", ["refuse"], ["input"]),
      rootConfinement: readLiteral(inputRules, "rootConfinement", ["required", "optional"], ["input"]),
    },
    ceilings: {
      maximumFileBytes: readCeiling(ceilings, "maximumFileBytes", MAX_FILE_BYTES, ["ceilings"]),
      maximumLineBytes: readCeiling(ceilings, "maximumLineBytes", MAX_LINE_BYTES, ["ceilings"]),
      maximumRecordsPerFile: readCeiling(ceilings, "maximumRecordsPerFile", MAX_RECORDS_PER_FILE, ["ceilings"]),
      maximumNestingDepth: readCeiling(ceilings, "maximumNestingDepth", MAX_NESTING_DEPTH, ["ceilings"]),
      maximumProcessingMillisPerFile: readCeiling(
        ceilings,
        "maximumProcessingMillisPerFile",
        MAX_PROCESSING_MILLIS_PER_FILE,
        ["ceilings"],
      ),
    },
    decoding: { compressedInput: readLiteral(decoding, "compressedInput", ["refuse"], ["decoding"]) },
    persistence: {
      rawContent: readLiteral(persistence, "rawContent", ["never"], ["persistence"]),
      messageText: readLiteral(persistence, "messageText", ["structural_features_only"], ["persistence"]),
      privateIdentities: readLiteral(persistence, "privateIdentities", ["tenant_keyed"], ["persistence"]),
      diagnostics: readLiteral(persistence, "diagnostics", ["static_codes_only"], ["persistence"]),
    },
    recurrence: { duplicateSegments: readLiteral(recurrence, "duplicateSegments", ["collapse"], ["recurrence"]) },
    outbound: { modelCalls: readLiteral(outbound, "modelCalls", ["forbidden"], ["outbound"]) },
    publication: { derivedArtifacts: readLiteral(publication, "derivedArtifacts", ["private"], ["publication"]) },
    processingBasis: {
      classification: readLiteral(processingBasis, "classification", ["sensitive_untrusted"], ["processingBasis"]),
      basis: readLiteral(processingBasis, "basis", ["explicit_user_selection"], ["processingBasis"]),
      trustMaximum: readLiteral(processingBasis, "trustMaximum", ["advisory"], ["processingBasis"]),
    },
    disposition: {
      onSourceDeletion: readLiteral(
        disposition,
        "onSourceDeletion",
        ["tombstone_and_refuse", "retain_under_basis", "queue_human_disposition"],
        ["disposition"],
      ),
      onConsentRevocation: readLiteral(
        disposition,
        "onConsentRevocation",
        ["tombstone_and_refuse", "queue_human_disposition"],
        ["disposition"],
      ),
    },
  };
  if (content.ceilings.maximumLineBytes > content.ceilings.maximumFileBytes) {
    throw policyError("maximumLineBytes cannot exceed maximumFileBytes", ["ceilings", "maximumLineBytes"]);
  }
  const policyDigest = record.policyDigest;
  if (typeof policyDigest !== "string" || !DIGEST_PATTERN.test(policyDigest)) {
    throw policyError("policyDigest must be a lowercase SHA-256 hex digest", ["policyDigest"]);
  }
  if (policyDigest !== transcriptPrivacyPolicyDigest(content)) {
    throw policyError("policyDigest does not match the policy content", ["policyDigest"], "schema.corrupt");
  }
  return deepFreeze({ schemaVersion: 1, ...content, policyDigest });
}

const DEFAULT_POLICY_ID = "transcript-privacy-default";
const DEFAULT_POLICY_VERSION = "1.0.0";

/**
 * The shipped conservative default: every ceiling at its shipped maximum,
 * root confinement required, and every closed literal at its only admitted
 * value. Hosts may tighten ceilings or choose a disposition; nothing here can
 * be loosened through policy content.
 */
export function defaultTranscriptPrivacyPolicy(): TranscriptPrivacyPolicy {
  const content: PolicyContent = {
    id: DEFAULT_POLICY_ID,
    version: DEFAULT_POLICY_VERSION,
    input: {
      mechanism: "explicit_files",
      discovery: "forbidden",
      access: "read_only",
      symlinks: "refuse",
      rootConfinement: "required",
    },
    ceilings: {
      maximumFileBytes: MAX_FILE_BYTES,
      maximumLineBytes: MAX_LINE_BYTES,
      maximumRecordsPerFile: MAX_RECORDS_PER_FILE,
      maximumNestingDepth: MAX_NESTING_DEPTH,
      maximumProcessingMillisPerFile: MAX_PROCESSING_MILLIS_PER_FILE,
    },
    decoding: { compressedInput: "refuse" },
    persistence: {
      rawContent: "never",
      messageText: "structural_features_only",
      privateIdentities: "tenant_keyed",
      diagnostics: "static_codes_only",
    },
    recurrence: { duplicateSegments: "collapse" },
    outbound: { modelCalls: "forbidden" },
    publication: { derivedArtifacts: "private" },
    processingBasis: {
      classification: "sensitive_untrusted",
      basis: "explicit_user_selection",
      trustMaximum: "advisory",
    },
    disposition: { onSourceDeletion: "tombstone_and_refuse", onConsentRevocation: "tombstone_and_refuse" },
  };
  return parseTranscriptPrivacyPolicy({
    schemaVersion: 1,
    ...content,
    policyDigest: transcriptPrivacyPolicyDigest(content),
  });
}
