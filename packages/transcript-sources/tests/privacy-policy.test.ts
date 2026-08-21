// TranscriptPrivacyPolicy (decision 0024): content-addressed, closed-literal,
// tighten-only, parsed from unknown, and declared by every adapter descriptor.
import { LearningLoopError } from "@cormidia/learning-loop";
import { describe, expect, it } from "vitest";
import type { TranscriptPrivacyPolicy } from "../src/index.js";
import {
  MAX_FILE_BYTES,
  MAX_LINE_BYTES,
  MAX_NESTING_DEPTH,
  MAX_PROCESSING_MILLIS_PER_FILE,
  MAX_RECORDS_PER_FILE,
  createClaudeCodeTranscriptSource,
  createCodexTranscriptSource,
  defaultTranscriptPrivacyPolicy,
  parseTranscriptPrivacyPolicy,
  transcriptPrivacyPolicyDigest,
} from "../src/index.js";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };

function clone(policy: TranscriptPrivacyPolicy): Mutable<TranscriptPrivacyPolicy> {
  return JSON.parse(JSON.stringify(policy));
}

/** Applies a mutation, recomputes the digest honestly, and returns the candidate bytes. */
function variant(mutate: (policy: Mutable<TranscriptPrivacyPolicy>) => void): unknown {
  const policy = clone(defaultTranscriptPrivacyPolicy());
  mutate(policy);
  const { schemaVersion, policyDigest, ...content } = policy;
  void policyDigest;
  return { schemaVersion, ...content, policyDigest: transcriptPrivacyPolicyDigest(content) };
}

function errorCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof LearningLoopError) return error.code;
    throw error;
  }
  throw new Error("expected a LearningLoopError");
}

describe("transcript privacy policy", () => {
  it("ships a frozen conservative default with a pinned content digest", () => {
    const policy = defaultTranscriptPrivacyPolicy();
    expect(policy.id).toBe("transcript-privacy-default");
    expect(policy.version).toBe("1.0.0");
    expect(policy.input).toEqual({
      mechanism: "explicit_files",
      discovery: "forbidden",
      access: "read_only",
      symlinks: "refuse",
      rootConfinement: "required",
    });
    expect(policy.ceilings).toEqual({
      maximumFileBytes: MAX_FILE_BYTES,
      maximumLineBytes: MAX_LINE_BYTES,
      maximumRecordsPerFile: MAX_RECORDS_PER_FILE,
      maximumNestingDepth: MAX_NESTING_DEPTH,
      maximumProcessingMillisPerFile: MAX_PROCESSING_MILLIS_PER_FILE,
    });
    expect(policy.outbound.modelCalls).toBe("forbidden");
    expect(policy.persistence.rawContent).toBe("never");
    expect(policy.decoding.compressedInput).toBe("refuse");
    expect(policy.publication.derivedArtifacts).toBe("private");
    expect(policy.processingBasis.trustMaximum).toBe("advisory");
    expect(policy.recurrence.duplicateSegments).toBe("collapse");
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.ceilings)).toBe(true);
    expect(policy.policyDigest).toBe(transcriptPrivacyPolicyDigest(policy));
    // Golden: changing the shipped default is a deliberate, visible decision.
    expect(policy.policyDigest).toBe("09cec07b9745cf754f791a0c050c9d879dd0b2f83a3afaaa51211726c83e74f1");
    expect(parseTranscriptPrivacyPolicy(JSON.parse(JSON.stringify(policy)))).toEqual(policy);
    expect(defaultTranscriptPrivacyPolicy()).toEqual(policy);
  });

  it("is content-addressed: every content change changes the digest and a stale digest is corruption", () => {
    const base = defaultTranscriptPrivacyPolicy();
    const tightened = parseTranscriptPrivacyPolicy(
      variant((policy) => {
        policy.ceilings.maximumLineBytes = 4_096;
      }),
    );
    const redisposed = parseTranscriptPrivacyPolicy(
      variant((policy) => {
        policy.disposition.onSourceDeletion = "queue_human_disposition";
      }),
    );
    const renamed = parseTranscriptPrivacyPolicy(
      variant((policy) => {
        policy.id = "host-policy";
        policy.version = "2.0.0";
      }),
    );
    const optionalRoots = parseTranscriptPrivacyPolicy(
      variant((policy) => {
        policy.input.rootConfinement = "optional";
      }),
    );
    const digests = new Set([base, tightened, redisposed, renamed, optionalRoots].map((policy) => policy.policyDigest));
    expect(digests.size).toBe(5);
    expect(tightened.ceilings.maximumLineBytes).toBe(4_096);

    const stale = { ...clone(base), policyDigest: tightened.policyDigest };
    expect(errorCode(() => parseTranscriptPrivacyPolicy(stale))).toBe("schema.corrupt");
    expect(errorCode(() => parseTranscriptPrivacyPolicy({ ...clone(base), policyDigest: "nope" }))).toBe(
      "schema.invalid",
    );
    // Unknown fields never enter the digest: a digest computed over them does not verify.
    const extra = { ...clone(base), outboundAllowlist: ["evil.example"] };
    expect(parseTranscriptPrivacyPolicy(extra)).toEqual(base);
  });

  it("refuses every loosening as schema.invalid even with an honestly recomputed digest", () => {
    const loosenings: readonly ((policy: Mutable<TranscriptPrivacyPolicy>) => void)[] = [
      (policy) => {
        policy.input.discovery = "home_directory" as never;
      },
      (policy) => {
        policy.input.mechanism = "glob" as never;
      },
      (policy) => {
        policy.input.symlinks = "follow" as never;
      },
      (policy) => {
        policy.input.access = "read_write" as never;
      },
      (policy) => {
        policy.input.rootConfinement = "disabled" as never;
      },
      (policy) => {
        policy.decoding.compressedInput = "inflate" as never;
      },
      (policy) => {
        policy.persistence.rawContent = "opt_in" as never;
      },
      (policy) => {
        policy.persistence.messageText = "verbatim" as never;
      },
      (policy) => {
        policy.persistence.privateIdentities = "plain" as never;
      },
      (policy) => {
        policy.persistence.diagnostics = "verbose" as never;
      },
      (policy) => {
        policy.recurrence.duplicateSegments = "count" as never;
      },
      (policy) => {
        policy.outbound.modelCalls = "allowed" as never;
      },
      (policy) => {
        policy.outbound.modelCalls = true as never;
      },
      (policy) => {
        policy.publication.derivedArtifacts = "public" as never;
      },
      (policy) => {
        policy.processingBasis.trustMaximum = "verified" as never;
      },
      (policy) => {
        policy.processingBasis.classification = "public" as never;
      },
      (policy) => {
        policy.disposition.onSourceDeletion = "ignore" as never;
      },
      (policy) => {
        policy.disposition.onConsentRevocation = "retain_under_basis" as never;
      },
    ];
    for (const loosen of loosenings) {
      expect(errorCode(() => parseTranscriptPrivacyPolicy(variant(loosen)))).toBe("schema.invalid");
    }
  });

  it("lets ceilings only tighten the shipped maxima", () => {
    const loosenings: readonly ((policy: Mutable<TranscriptPrivacyPolicy>) => void)[] = [
      (policy) => {
        policy.ceilings.maximumFileBytes = MAX_FILE_BYTES + 1;
      },
      (policy) => {
        policy.ceilings.maximumLineBytes = MAX_LINE_BYTES + 1;
      },
      (policy) => {
        policy.ceilings.maximumRecordsPerFile = MAX_RECORDS_PER_FILE + 1;
      },
      (policy) => {
        policy.ceilings.maximumNestingDepth = MAX_NESTING_DEPTH + 1;
      },
      (policy) => {
        policy.ceilings.maximumProcessingMillisPerFile = MAX_PROCESSING_MILLIS_PER_FILE + 1;
      },
      (policy) => {
        policy.ceilings.maximumRecordsPerFile = 0;
      },
      (policy) => {
        policy.ceilings.maximumNestingDepth = 1.5;
      },
      (policy) => {
        policy.ceilings.maximumLineBytes = Number.NaN;
      },
      (policy) => {
        policy.ceilings.maximumFileBytes = 1_024;
        policy.ceilings.maximumLineBytes = 2_048;
      },
    ];
    for (const loosen of loosenings) {
      expect(errorCode(() => parseTranscriptPrivacyPolicy(variant(loosen)))).toBe("schema.invalid");
    }
    const tightened = parseTranscriptPrivacyPolicy(
      variant((policy) => {
        policy.ceilings = {
          maximumFileBytes: 1_048_576,
          maximumLineBytes: 65_536,
          maximumRecordsPerFile: 1_000,
          maximumNestingDepth: 16,
          maximumProcessingMillisPerFile: 5_000,
        };
      }),
    );
    expect(tightened.ceilings.maximumRecordsPerFile).toBe(1_000);
  });

  it("refuses foreign schema versions, malformed ids, and non-objects", () => {
    expect(
      errorCode(() => parseTranscriptPrivacyPolicy({ ...clone(defaultTranscriptPrivacyPolicy()), schemaVersion: 2 })),
    ).toBe("schema.unsupported_version");
    expect(errorCode(() => parseTranscriptPrivacyPolicy(null))).toBe("schema.invalid");
    expect(errorCode(() => parseTranscriptPrivacyPolicy("policy"))).toBe("schema.invalid");
    expect(
      errorCode(() =>
        parseTranscriptPrivacyPolicy(
          variant((policy) => {
            policy.id = "tenant/policy";
          }),
        ),
      ),
    ).toBe("schema.invalid");
    expect(
      errorCode(() =>
        parseTranscriptPrivacyPolicy(
          variant((policy) => {
            policy.version = "latest";
          }),
        ),
      ),
    ).toBe("schema.invalid");
  });

  it("is declared by every adapter descriptor as a frozen { id, digest } reference", () => {
    const defaults = defaultTranscriptPrivacyPolicy();
    for (const source of [createClaudeCodeTranscriptSource(), createCodexTranscriptSource()]) {
      expect(source.descriptor.privacyPolicy).toEqual({ id: defaults.id, digest: defaults.policyDigest });
      expect(Object.isFrozen(source.descriptor.privacyPolicy)).toBe(true);
      expect(source.descriptor.maximumTrust).toBe("advisory");
    }
    const custom = parseTranscriptPrivacyPolicy(
      variant((policy) => {
        policy.id = "host-tightened";
        policy.ceilings.maximumRecordsPerFile = 10;
      }),
    );
    const declared = createCodexTranscriptSource({ privacyPolicy: custom }).descriptor.privacyPolicy;
    expect(declared).toEqual({ id: "host-tightened", digest: custom.policyDigest });
    expect(declared?.digest).not.toBe(defaults.policyDigest);
  });

  it("parses the configured policy from unknown at the factory boundary", () => {
    const stale = { ...clone(defaultTranscriptPrivacyPolicy()), policyDigest: "f".repeat(64) };
    expect(errorCode(() => createClaudeCodeTranscriptSource({ privacyPolicy: stale as never }))).toBe("schema.corrupt");
    expect(errorCode(() => createCodexTranscriptSource({ privacyPolicy: "default" as never }))).toBe("schema.invalid");
    expect(
      errorCode(() =>
        createClaudeCodeTranscriptSource({
          privacyPolicy: variant((policy) => {
            policy.outbound.modelCalls = "allowed" as never;
          }) as never,
        }),
      ),
    ).toBe("schema.invalid");
  });
});
