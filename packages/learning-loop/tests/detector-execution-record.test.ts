// #30b1 immutable detector invocation/result facts.
import { describe, expect, it } from "vitest";
import type {
  DetectorExecutionRecord,
  EvidenceHealthFinding,
  EvidenceRefV1,
  ObservationEvidenceRef,
  SourceSemanticProfile,
} from "../src/index.js";
import {
  detectorExecutionDigest,
  detectorExecutionKeyDigest,
  evidenceRefDigest,
  parseDetectorExecutionRecord,
  parseSourceSemanticProfile,
  scopeDigest,
  sha256HexOfCanonicalJson,
  sourceSemanticProfileDigest,
  toJsonValue,
} from "../src/index.js";
import { evidenceHealthFindingDigest } from "../src/records/source-health.js";

const EXECUTION_SCOPE = [{ type: "project", id: "execution-project" }] as const;
const LOOP_REGISTRY_REVISION = "1".repeat(64);

function digest(value: unknown): string {
  return sha256HexOfCanonicalJson(toJsonValue(value));
}

function profile(
  input: {
    readonly sourceId?: string;
    readonly sourceRevision?: string;
    readonly capabilities?: readonly string[];
    readonly kinds?: readonly string[];
  } = {},
): SourceSemanticProfile {
  const base: Omit<SourceSemanticProfile, "schemaVersion" | "profileDigest"> = {
    sourceId: input.sourceId ?? "execution-source",
    sourceRegistrationRevision: input.sourceRevision ?? "2".repeat(64),
    observationVocabularyDigest: "3".repeat(64),
    capabilities: input.capabilities ?? ["operation.state"],
    observationKinds: input.kinds ?? ["operation.completed"],
  };
  return parseSourceSemanticProfile({
    schemaVersion: 1,
    ...base,
    profileDigest: sourceSemanticProfileDigest(base),
  });
}

const PROFILE = profile();

function observationEvidence(): ObservationEvidenceRef {
  const episode = {
    sourceId: PROFILE.sourceId,
    episodeId: "execution-episode",
    episodeRecordId: `${PROFILE.sourceId}/episode-record`,
    episodeRecordDigest: "4".repeat(64),
    episodeIdentityDigest: "5".repeat(64),
    scopeDigest: scopeDigest(EXECUTION_SCOPE),
    pageReceiptId: `source-page-${"6".repeat(64)}`,
    pageReceiptDigest: "6".repeat(64),
  };
  const bound: Omit<EvidenceRefV1, "schemaVersion" | "referenceDigest"> = {
    kind: "observation",
    recordId: `${PROFILE.sourceId}/observation-1`,
    recordDigest: "7".repeat(64),
    sourceId: PROFILE.sourceId,
    sourceRegistrationRevision: PROFILE.sourceRegistrationRevision,
    sourceRef: "tenant-keyed-artifact",
    sourceRevision: "artifact-revision",
    sourceRecordId: "observation-1",
    pageRef: "observation-page",
    pageReceiptId: `source-page-${"8".repeat(64)}`,
    pageReceiptDigest: "8".repeat(64),
    loopRegistryRevision: LOOP_REGISTRY_REVISION,
    trust: "observed",
    completeness: "complete",
    episode,
  };
  return {
    schemaVersion: 1,
    ...bound,
    kind: "observation",
    referenceDigest: evidenceRefDigest(bound),
  };
}

const EVIDENCE = observationEvidence();

const HEALTH_BASE = {
  code: "source.partial" as const,
  effect: "limits_claims" as const,
  sourceId: PROFILE.sourceId,
  sourceRegistrationRevision: PROFILE.sourceRegistrationRevision,
  sourceRef: "tenant-keyed-artifact",
  pageRef: "observation-page",
  completeness: "partial" as const,
  affectedRecords: 1,
};
const HEALTH_DIGEST = evidenceHealthFindingDigest(HEALTH_BASE);
const HEALTH: EvidenceHealthFinding = {
  schemaVersion: 1,
  id: `evidence-health-${HEALTH_DIGEST}`,
  ...HEALTH_BASE,
  findingDigest: HEALTH_DIGEST,
};

function healthFinding(
  input: { readonly sourceId?: string; readonly sourceRegistrationRevision?: string } = {},
): EvidenceHealthFinding {
  const base = {
    ...HEALTH_BASE,
    sourceId: input.sourceId ?? HEALTH.sourceId,
    sourceRegistrationRevision: input.sourceRegistrationRevision ?? HEALTH.sourceRegistrationRevision,
  };
  const findingDigest = evidenceHealthFindingDigest(base);
  return {
    schemaVersion: 1,
    id: `evidence-health-${findingDigest}`,
    ...base,
    findingDigest,
  };
}

function populationEpisode(episodeRecordId = EVIDENCE.episode.episodeRecordId) {
  const bound = {
    episodeRecordId,
    episodeRecordDigest: EVIDENCE.episode.episodeRecordDigest,
    episodeIdentityDigest: EVIDENCE.episode.episodeIdentityDigest,
    outcomeClaimDigest: null,
    scopeDigest: scopeDigest(EXECUTION_SCOPE),
  };
  return { ...bound, episodeViewDigest: digest(bound) };
}

function execution(
  input: {
    readonly outputKind?: DetectorExecutionRecord["outputKind"];
    readonly lens?: DetectorExecutionRecord["lens"];
    readonly result?: DetectorExecutionRecord["result"];
    readonly sourceProfiles?: readonly SourceSemanticProfile[];
    readonly episodes?: readonly ReturnType<typeof populationEpisode>[];
    readonly evidenceRefs?: readonly ObservationEvidenceRef[];
    readonly windowHealth?: readonly EvidenceHealthFinding[];
    readonly availableCapabilities?: readonly string[];
    readonly scope?: DetectorExecutionRecord["scope"];
  } = {},
): DetectorExecutionRecord {
  const outputKind = input.outputKind ?? "insight_derivation";
  const lens =
    input.lens === undefined
      ? outputKind === "insight_derivation"
        ? { id: "execution-lens", version: "1.0.0", registrationDigest: "9".repeat(64) }
        : null
      : input.lens;
  const sourceProfiles = input.sourceProfiles ?? [PROFILE];
  const episodes = input.episodes ?? [populationEpisode()];
  const normalizationPolicyDigest = "a".repeat(64);
  const comparabilityPolicyDigest = null;
  const population = {
    episodes,
    normalizationPolicyDigest,
    comparabilityPolicyDigest,
    populationDigest: digest({ episodes, normalizationPolicyDigest, comparabilityPolicyDigest }),
  };
  const evidenceRefs = input.evidenceRefs ?? [EVIDENCE];
  const evidenceHealthFindings = input.windowHealth ?? [];
  const availableCapabilities = input.availableCapabilities ?? ["operation.state"];
  const windowBase = {
    sourceProfiles,
    population,
    evidenceRefs,
    evidenceHealthFindings,
    availableCapabilities,
  };
  const window = { ...windowBase, windowDigest: digest(windowBase) };
  const scope = input.scope ?? EXECUTION_SCOPE;
  const base = {
    loopRegistryRevision: LOOP_REGISTRY_REVISION,
    detector: {
      id: "host.detector",
      version: "1.0.0",
      registrationDigest: "b".repeat(64),
      configurationDigest: "c".repeat(64),
      implementationDigest: "d".repeat(64),
    },
    pack: { id: "host-pack", version: "1.0.0", manifestDigest: "e".repeat(64) },
    lens,
    scope,
    scopeDigest: scopeDigest(scope),
    scopePolicyDigest: "f".repeat(64),
    outputKind,
    window,
  };
  const result =
    input.result ??
    ({
      status: "applied",
      conditionDetected: true,
      derivationRefs: [
        { id: `insight-${"0".repeat(64)}`, derivationDigest: "0".repeat(64), scopeDigest: scopeDigest(scope) },
      ],
      evidenceHealthFindings: [],
    } as const);
  const executionKeyDigest = detectorExecutionKeyDigest(base);
  const digestInput = { ...base, result, executionKeyDigest };
  const executionDigest = detectorExecutionDigest(digestInput);
  return parseDetectorExecutionRecord({
    schemaVersion: 1,
    id: `detector-execution-${executionKeyDigest}`,
    ...digestInput,
    executionDigest,
  });
}

const APPLIED_TRUE = execution();
const APPLIED_FALSE = execution({
  result: { status: "applied", conditionDetected: false, derivationRefs: [], evidenceHealthFindings: [] },
});

function redigested(input: DetectorExecutionRecord): unknown {
  const executionKeyDigest = detectorExecutionKeyDigest(input);
  const executionDigest = detectorExecutionDigest({ ...input, executionKeyDigest });
  return {
    ...input,
    id: `detector-execution-${executionKeyDigest}`,
    executionKeyDigest,
    executionDigest,
  };
}

describe("DetectorExecutionRecord identity and immutable window", () => {
  it("round-trips unknown, drops unknown fields, and pins key/execution goldens", () => {
    expect(parseDetectorExecutionRecord({ ...APPLIED_TRUE, future: true })).toEqual(APPLIED_TRUE);
    expect(APPLIED_TRUE.executionKeyDigest).toBe("3e392b9e8339156451277f01fbd1df27b3b0ba81dc29235510966c9c53488e6d");
    expect(APPLIED_TRUE.executionDigest).toBe("25e72111e453dfb16f21bcde2da8d5be86c25283d6a7b884ae045f3532112a0d");
    expect(APPLIED_TRUE.id).toBe(`detector-execution-${APPLIED_TRUE.executionKeyDigest}`);
  });

  it("rejects schema/missing/wrong types and all stale ids/digests", () => {
    expect(() => parseDetectorExecutionRecord({ ...APPLIED_TRUE, schemaVersion: 2 })).toThrowError(
      expect.objectContaining({ code: "schema.unsupported_version" }),
    );
    expect(() => parseDetectorExecutionRecord({ ...APPLIED_TRUE, detector: 42 })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      parseDetectorExecutionRecord({ ...APPLIED_TRUE, id: `detector-execution-${"1".repeat(64)}` }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() => parseDetectorExecutionRecord({ ...APPLIED_TRUE, executionDigest: "1".repeat(64) })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("recomputes episode views, population, available capability union, and the whole window", () => {
    const episode = APPLIED_TRUE.window.population.episodes[0];
    if (episode === undefined) throw new Error("missing episode fixture");
    expect(() =>
      parseDetectorExecutionRecord(
        redigested({
          ...APPLIED_TRUE,
          window: {
            ...APPLIED_TRUE.window,
            population: {
              ...APPLIED_TRUE.window.population,
              episodes: [{ ...episode, episodeRecordDigest: "1".repeat(64) }],
            },
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() =>
      parseDetectorExecutionRecord(
        redigested({
          ...APPLIED_TRUE,
          window: { ...APPLIED_TRUE.window, availableCapabilities: ["forged.capability"] },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() =>
      parseDetectorExecutionRecord(
        redigested({
          ...APPLIED_TRUE,
          window: { ...APPLIED_TRUE.window, windowDigest: "1".repeat(64) },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("derives available capabilities as the exact sorted union of all source profiles", () => {
    const secondProfile = profile({
      sourceId: "second-execution-source",
      sourceRevision: "0".repeat(64),
      capabilities: ["context.compaction", "operation.state"],
      kinds: ["context.compacted"],
    });
    const profiles = [PROFILE, secondProfile].sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
    );
    const value = execution({
      sourceProfiles: profiles,
      availableCapabilities: ["context.compaction", "operation.state"],
    });
    expect(value.window.availableCapabilities).toEqual(["context.compaction", "operation.state"]);
    expect(() => execution({ sourceProfiles: profiles, availableCapabilities: ["operation.state"] })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("requires exact execution scope across population, evidence, and derivation refs", () => {
    const episode = APPLIED_TRUE.window.population.episodes[0];
    if (episode === undefined) throw new Error("missing episode fixture");
    const otherScope = scopeDigest([{ type: "project", id: "other" }]);
    const populationEpisodes = [{ ...episode, scopeDigest: otherScope }];
    const population = {
      ...APPLIED_TRUE.window.population,
      episodes: populationEpisodes,
      populationDigest: digest({
        episodes: populationEpisodes,
        normalizationPolicyDigest: APPLIED_TRUE.window.population.normalizationPolicyDigest,
        comparabilityPolicyDigest: APPLIED_TRUE.window.population.comparabilityPolicyDigest,
      }),
    };
    expect(() =>
      parseDetectorExecutionRecord(redigested({ ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, population } })),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const wrongEvidenceBound = { ...EVIDENCE, episode: { ...EVIDENCE.episode, scopeDigest: otherScope } };
    const wrongEvidence = { ...wrongEvidenceBound, referenceDigest: evidenceRefDigest(wrongEvidenceBound) };
    expect(() =>
      parseDetectorExecutionRecord(
        redigested({ ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, evidenceRefs: [wrongEvidence] } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));

    const result = {
      status: "applied" as const,
      conditionDetected: true,
      derivationRefs: [{ id: `insight-${"0".repeat(64)}`, derivationDigest: "0".repeat(64), scopeDigest: otherScope }],
      evidenceHealthFindings: [],
    };
    expect(() => parseDetectorExecutionRecord(redigested({ ...APPLIED_TRUE, result }))).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("requires evidence source profiles and exact loop registry revision", () => {
    const wrongRegistryBound = { ...EVIDENCE, loopRegistryRevision: "0".repeat(64) };
    const wrongRegistry = { ...wrongRegistryBound, referenceDigest: evidenceRefDigest(wrongRegistryBound) };
    expect(() =>
      parseDetectorExecutionRecord(
        redigested({ ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, evidenceRefs: [wrongRegistry] } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
    expect(() =>
      parseDetectorExecutionRecord(
        redigested({ ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, sourceProfiles: [] } }),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("binds input and applied-output health findings to exact source profiles", () => {
    expect(execution({ windowHealth: [HEALTH] }).window.evidenceHealthFindings).toEqual([HEALTH]);
    const matchingOutput = execution({
      outputKind: "evidence_health",
      lens: null,
      result: {
        status: "applied",
        conditionDetected: true,
        derivationRefs: [],
        evidenceHealthFindings: [HEALTH],
      },
    });
    expect(matchingOutput.result).toMatchObject({ evidenceHealthFindings: [HEALTH] });

    const foreignSource = healthFinding({ sourceId: "foreign-execution-source" });
    expect(() => execution({ windowHealth: [foreignSource] })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );

    const foreignRevision = healthFinding({ sourceRegistrationRevision: "0".repeat(64) });
    expect(() =>
      execution({
        outputKind: "evidence_health",
        lens: null,
        result: {
          status: "applied",
          conditionDetected: true,
          derivationRefs: [],
          evidenceHealthFindings: [foreignRevision],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("accepts 4096-character durable population ids and rejects longer ids", () => {
    const prefix = `${PROFILE.sourceId}/`;
    const maximumId = `${prefix}${"e".repeat(4_096 - prefix.length)}`;
    const excessiveId = `${prefix}${"e".repeat(4_097 - prefix.length)}`;
    expect(
      execution({ episodes: [populationEpisode(maximumId)] }).window.population.episodes[0]?.episodeRecordId,
    ).toHaveLength(4_096);
    expect(() => execution({ episodes: [populationEpisode(excessiveId)] })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
  });

  it("requires every population episode to belong to exactly one profiled source", () => {
    expect(execution().window.population.episodes[0]?.episodeRecordId).toBe(`${PROFILE.sourceId}/episode-record`);
    expect(() => execution({ episodes: [populationEpisode("foreign-source/episode-record")] })).toThrowError(
      expect.objectContaining({ code: "schema.corrupt" }),
    );
  });

  it("includes every invocation/window field in key and only result in the execution digest", () => {
    const sameKeyDifferentResult = APPLIED_FALSE;
    expect(sameKeyDifferentResult.executionKeyDigest).toBe(APPLIED_TRUE.executionKeyDigest);
    expect(sameKeyDifferentResult.id).toBe(APPLIED_TRUE.id);
    expect(sameKeyDifferentResult.executionDigest).not.toBe(APPLIED_TRUE.executionDigest);
    const mutations: readonly DetectorExecutionRecord[] = [
      { ...APPLIED_TRUE, loopRegistryRevision: "0".repeat(64) },
      { ...APPLIED_TRUE, detector: { ...APPLIED_TRUE.detector, implementationDigest: "0".repeat(64) } },
      { ...APPLIED_TRUE, pack: { ...APPLIED_TRUE.pack, manifestDigest: "0".repeat(64) } },
      { ...APPLIED_TRUE, lens: null },
      { ...APPLIED_TRUE, scopePolicyDigest: "0".repeat(64) },
      { ...APPLIED_TRUE, outputKind: "evidence_health" },
      { ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, evidenceHealthFindings: [HEALTH] } },
    ];
    for (const mutation of mutations) {
      expect(detectorExecutionKeyDigest(mutation)).not.toBe(APPLIED_TRUE.executionKeyDigest);
    }
  });
});

describe("DetectorExecutionRecord closed result semantics", () => {
  it("accepts applied true/false only with the output family selected by outputKind", () => {
    expect(APPLIED_TRUE.result).toMatchObject({ status: "applied", conditionDetected: true });
    expect(APPLIED_FALSE.result).toEqual({
      status: "applied",
      conditionDetected: false,
      derivationRefs: [],
      evidenceHealthFindings: [],
    });
    const healthExecution = execution({
      outputKind: "evidence_health",
      lens: null,
      result: {
        status: "applied",
        conditionDetected: true,
        derivationRefs: [],
        evidenceHealthFindings: [HEALTH],
      },
    });
    expect(healthExecution.result).toMatchObject({ status: "applied", conditionDetected: true });

    const invalidResults: readonly DetectorExecutionRecord["result"][] = [
      {
        status: "applied",
        conditionDetected: false,
        derivationRefs: APPLIED_TRUE.result.status === "applied" ? APPLIED_TRUE.result.derivationRefs : [],
        evidenceHealthFindings: [],
      },
      { status: "applied", conditionDetected: true, derivationRefs: [], evidenceHealthFindings: [] },
      { status: "applied", conditionDetected: true, derivationRefs: [], evidenceHealthFindings: [HEALTH] },
    ];
    for (const result of invalidResults) {
      expect(() => execution({ result })).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
    }
  });

  it("enforces lens/output alignment", () => {
    expect(() => execution({ outputKind: "insight_derivation", lens: null })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      execution({
        outputKind: "evidence_health",
        lens: { id: "lens", version: "1.0.0", registrationDigest: "1".repeat(64) },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.invalid" }));
  });

  it("accepts not_applicable and incomplete only with nonempty reasons and disjoint sorted missing capabilities", () => {
    const notApplicable = execution({
      result: {
        status: "not_applicable",
        reasonCodes: ["capability.absent"],
        missingCapabilities: ["context.compaction"],
      },
    });
    const incomplete = execution({
      windowHealth: [HEALTH],
      result: { status: "incomplete", reasonCodes: ["evidence.partial"], missingCapabilities: [] },
    });
    expect(notApplicable.result).toMatchObject({ status: "not_applicable" });
    expect(incomplete.result).toMatchObject({ status: "incomplete" });
    const invalidResults: readonly DetectorExecutionRecord["result"][] = [
      { status: "not_applicable", reasonCodes: [], missingCapabilities: [] },
      { status: "incomplete", reasonCodes: ["z", "a"], missingCapabilities: [] },
      { status: "incomplete", reasonCodes: ["reason"], missingCapabilities: ["operation.state"] },
      { status: "incomplete", reasonCodes: ["reason"], missingCapabilities: ["z", "a"] },
    ];
    for (const result of invalidResults) {
      expect(() => execution({ result })).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });

  it("rejects status pass and full finding effect tamper", () => {
    expect(() => parseDetectorExecutionRecord({ ...APPLIED_TRUE, result: { status: "pass" } })).toThrowError(
      expect.objectContaining({ code: "schema.invalid" }),
    );
    expect(() =>
      execution({
        outputKind: "evidence_health",
        lens: null,
        result: {
          status: "applied",
          conditionDetected: true,
          derivationRefs: [],
          evidenceHealthFindings: [{ ...HEALTH, effect: "blocks_use" }],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "schema.corrupt" }));
  });

  it("rejects duplicate population/evidence/profile/capability/health/derivation identities", () => {
    const episode = APPLIED_TRUE.window.population.episodes[0];
    if (episode === undefined) throw new Error("missing episode fixture");
    const derivationReference =
      APPLIED_TRUE.result.status === "applied" ? APPLIED_TRUE.result.derivationRefs[0] : undefined;
    if (derivationReference === undefined) throw new Error("missing derivation fixture");
    const duplicateCases: readonly DetectorExecutionRecord[] = [
      {
        ...APPLIED_TRUE,
        window: {
          ...APPLIED_TRUE.window,
          population: { ...APPLIED_TRUE.window.population, episodes: [episode, episode] },
        },
      },
      { ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, evidenceRefs: [EVIDENCE, EVIDENCE] } },
      { ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, sourceProfiles: [PROFILE, PROFILE] } },
      {
        ...APPLIED_TRUE,
        window: { ...APPLIED_TRUE.window, availableCapabilities: ["operation.state", "operation.state"] },
      },
      { ...APPLIED_TRUE, window: { ...APPLIED_TRUE.window, evidenceHealthFindings: [HEALTH, HEALTH] } },
      {
        ...APPLIED_TRUE,
        result: {
          status: "applied",
          conditionDetected: true,
          derivationRefs: [derivationReference, derivationReference],
          evidenceHealthFindings: [],
        },
      },
    ];
    for (const value of duplicateCases) {
      expect(() => parseDetectorExecutionRecord(redigested(value))).toThrowError(
        expect.objectContaining({ code: expect.stringMatching(/^schema\./) }),
      );
    }
  });
});
