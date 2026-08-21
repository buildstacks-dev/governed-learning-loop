import { describe, expect, it } from "vitest";
import type { DetectorRegistration } from "@cormidia/learning-loop";
import type { ReferenceDetectorBundle } from "@cormidia/learning-loop/reference-detectors";
import {
  allReferenceDetectors,
  createReferenceBundle,
  createReferenceHarness,
  detectorRef,
  lensRef,
  packRef,
  parseReferenceFixtureInput,
} from "./reference-detector-harness.js";

const FAMILIES = [
  "attributed_human_redirection",
  "context_pressure_compaction",
  "coordination_attribution_integrity",
  "coordination_fanout",
  "repeated_status_polling",
  "tool_use_concentration",
] as const;
type Family = (typeof FAMILIES)[number];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function familyOf(detector: DetectorRegistration): Family {
  const family = FAMILIES.find((candidate) => detector.id.includes(`.${candidate}.`));
  if (family === undefined) throw new Error(`unknown reference detector family for ${detector.id}`);
  return family;
}

function detectorFor(bundle: ReferenceDetectorBundle, family: Family): DetectorRegistration {
  const detector = allReferenceDetectors(bundle).find((candidate) => familyOf(candidate) === family);
  if (detector === undefined) throw new Error(`missing reference detector ${family}`);
  return detector;
}

function fragmentFor(bundle: ReferenceDetectorBundle, family: Family) {
  return family === "coordination_attribution_integrity" ? bundle.coreStructural : bundle.referenceOperational;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

// These are the immutable released bytes for catalog v0.1.0. Any intentional
// semantic change must bump the catalog version and replace these vectors.
const V010_GOLDENS = deepFreeze({
  catalogVersion: "0.1.0",
  hostBindingDigest: "13c78965e0508f7083c9f48dee6c51e31057a5b0b7b4588baa0e59b01859dbe7",
  vocabularyDigest: "e8f396b7b5e4bad4ee67d1737c144c92d2ca1ecf8f4f59d1835b91ef9b9dec4f",
  detectorRegistrationDigests: [
    {
      family: "attributed_human_redirection",
      digest: "46e2400965968074c1b3e98fd5cb904fbdbf8c80f78b9ac8a42419a1305882de",
    },
    {
      family: "context_pressure_compaction",
      digest: "5799c33a444d5b00a01e3c647193d5780bab98c49c178a40528e129c901a98b6",
    },
    {
      family: "coordination_attribution_integrity",
      digest: "7a5813b591cf0ad04077f816599b8611e86dc1f68e5e662edce71003dacc35aa",
    },
    {
      family: "coordination_fanout",
      digest: "38301ec5a432c8d313a8648a82df90fbb1374bc97ac44fe3afcf31359e284c19",
    },
    {
      family: "repeated_status_polling",
      digest: "b7612e110c14c4d02312128ae356bad8e22962af0df5839c2b7c7864c4f01956",
    },
    {
      family: "tool_use_concentration",
      digest: "08336acf6fcc580d27bf1ddf8bc224d37cdbfd9e155b3332eedede3f058c3911",
    },
  ],
  packManifestDigests: {
    coreStructural: "f3161540ff388493e5f1a52e1a5fafa1a7b41630207b66b089caf837f1faca04",
    referenceOperational: "440559029084a890f4052d1c4e31fed36569d979d8c882d5466a4d81b783de25",
  },
  fixtureDigests: [
    {
      id: "reference.fixture.attributed_human_redirection.negative.v1",
      digest: "59bb2ebaf27f12fd261a263ba55789662231af26c8e32a4a60c6ae0824faae0a",
    },
    {
      id: "reference.fixture.attributed_human_redirection.positive.v1",
      digest: "9c958cd6e181979a39a1e5fcb1a4acc35bc11d028296943e666ea63527f2fb15",
    },
    {
      id: "reference.fixture.context_pressure_compaction.negative.v1",
      digest: "b3abde4e025d844f99d3eccec1ca4230e510f3f0b9073b52270a6e3e752b95fc",
    },
    {
      id: "reference.fixture.context_pressure_compaction.positive.v1",
      digest: "dcf4703c0b2c4bad2ddb86c1268195ed78e81e1d5b5037392f50c6313da95c22",
    },
    {
      id: "reference.fixture.coordination_attribution_integrity.negative.v1",
      digest: "451722fea1cbfde13ab7c7423a63c83cf48144e86b7fc3d11130305f70baab89",
    },
    {
      id: "reference.fixture.coordination_attribution_integrity.positive.v1",
      digest: "d1090ee4a83f819330998af1b13f29e1216cd0da0adc28cc3f2970a2522cdb45",
    },
    {
      id: "reference.fixture.coordination_fanout.negative.v1",
      digest: "82b10fad601a84290dffbc075b0c07cf185261029aeac89f49c68cc52ed9988b",
    },
    {
      id: "reference.fixture.coordination_fanout.positive.v1",
      digest: "a2b927d73dd5a55860da780eb710b4efa3ba3379602b869122dad42463cdc2d9",
    },
    {
      id: "reference.fixture.repeated_status_polling.negative.v1",
      digest: "0ad07cbeac18c330f14849936d7d06e077a22deec1ccc09bf5d0d83bd6f92308",
    },
    {
      id: "reference.fixture.repeated_status_polling.positive.v1",
      digest: "22013114d4571a342fde5d0665b64c942b3bbb687ef6cfe621ddfc2754f0428c",
    },
    {
      id: "reference.fixture.tool_use_concentration.complex-legitimate-negative.v1",
      digest: "eb2cb3eff2851c6939b778a0fc56f00a42269750f5901d7d3360b6f1d89a68dd",
    },
    {
      id: "reference.fixture.tool_use_concentration.positive.v1",
      digest: "65e7bed0a9238e31ad1651fdcdf239e12a0beec6f37b15accfc0dd26ddb6babb",
    },
  ],
  positiveOutputs: [
    {
      family: "attributed_human_redirection",
      derivationDigest: "bb780577445498c4b26f87b853ffc420b135cb73b18e4462ceeed1bd4e100131",
      executionKeyDigest: "b6614c87ceeb53338737e6bd3bea451183742913122384eb307a3d254133e5a2",
      executionDigest: "5ccdf194d9819e4451664036ea4637e437a86f733e804fb8d6c1ac6a55114ffc",
    },
    {
      family: "context_pressure_compaction",
      derivationDigest: "113bbfac94d9ce7588596258c32f0856206d5028f0723c3c24f6b03ea211a091",
      executionKeyDigest: "811d4f166ebd46084a479cb83e40bf65a032e3c8341266cadb2312ce5ff09db6",
      executionDigest: "09db7477b86dbd5309f6792af48418cb5d9c6300f4a111a40830de0f79e5b8db",
    },
    {
      family: "coordination_attribution_integrity",
      derivationDigest: "945be231659319474399550561c6bee6f0a42de18c5e0e8fecbfdc0f881f6226",
      executionKeyDigest: "86a499639e56173465e0643419ebaa0202b941d715000927c2c21f9ee5c55f49",
      executionDigest: "9126e4e3852c9176bb0e7b47b960413094874f5b96c4b5f35a9d321dc835abca",
    },
    {
      family: "coordination_fanout",
      derivationDigest: "cce29f02a14365467ee62b9fd35367aff9ab125414bbcc64cd5096e2276d34d1",
      executionKeyDigest: "fd64fd735c32ed49fdea2748c390f1aa50bc8e9832c16680fbf047853c8b6443",
      executionDigest: "4d96d1637ee13e6a2136dcc0e72c7f26a77c6df18b648fa47a6f8d55f6f107f2",
    },
    {
      family: "repeated_status_polling",
      derivationDigest: "138c90bcb0cca05aecf7e5ac9268853ae175a8f5e6d495e40cba0874ccf59e36",
      executionKeyDigest: "b92e18ea0ad3502c845a3907e59ce27ed2b8021f963785b2261d8cc5f32d241b",
      executionDigest: "59a64ff8b1418fad2dcfb104795b0e652b2196ee1011bd727fb079bba4fddb27",
    },
    {
      family: "tool_use_concentration",
      derivationDigest: "42bf488a4d0031d27c33c2c89c59d57ce8ba835c3768484f4e52f05d22f3a326",
      executionKeyDigest: "1bf50224e73e5fe11a4359aad82f0347c976f2ba236b43662df47b258afefce7",
      executionDigest: "8970cf6b35b6e74079667ab84f4e5d028e9084981256c4e944f58084064222fa",
    },
  ],
});

describe("reference detector v0.1.0 golden vectors", () => {
  it("pins exact bundle and positive execution identities", async () => {
    const bundle = createReferenceBundle();
    const harness = createReferenceHarness({ bundle });
    const lens = bundle.lenses[0];
    if (lens === undefined) throw new Error("golden reference bundle requires a lens");
    const positiveOutputs: {
      family: Family;
      derivationDigest: string;
      executionKeyDigest: string;
      executionDigest: string;
    }[] = [];
    for (const family of FAMILIES) {
      const fixture = bundle.fixtures.find(
        (candidate) => candidate.detectorFamily === family && candidate.control === "positive",
      );
      if (fixture === undefined) throw new Error(`missing positive fixture for ${family}`);
      const input = parseReferenceFixtureInput(fixture.input);
      const receipt = await harness.learning.ingest(harness.source, input);
      const detector = detectorFor(bundle, family);
      const result = await harness.learning.runDetector({
        mode: "dry_run",
        detector: detectorRef(detector),
        pack: packRef(fragmentFor(bundle, family).pack),
        lens: lensRef(lens),
        scope: input.episodes?.[0]?.scope ?? [],
        episodeRecordIds: [...receipt.episodeIds].sort(compareText),
      });
      const derivation = result.derivations[0];
      const execution = result.execution;
      if (derivation === undefined || execution === undefined) {
        throw new Error(`positive fixture did not produce exact output for ${family}`);
      }
      positiveOutputs.push({
        family,
        derivationDigest: derivation.derivationDigest,
        executionKeyDigest: execution.executionKeyDigest,
        executionDigest: execution.executionDigest,
      });
    }
    const vectors = {
      catalogVersion: bundle.catalogVersion,
      hostBindingDigest: bundle.hostBindingDigest,
      vocabularyDigest: bundle.sourceRequirements.observationVocabularyDigest,
      detectorRegistrationDigests: allReferenceDetectors(bundle).map((detector) => ({
        family: familyOf(detector),
        digest: detector.registrationDigest,
      })),
      packManifestDigests: {
        coreStructural: bundle.coreStructural.pack.manifestDigest,
        referenceOperational: bundle.referenceOperational.pack.manifestDigest,
      },
      fixtureDigests: bundle.fixtures.map((fixture) => ({ id: fixture.id, digest: fixture.fixtureDigest })),
      positiveOutputs,
    };
    expect(vectors).toEqual(V010_GOLDENS);
    expect(Object.isFrozen(V010_GOLDENS)).toBe(true);
    expect(Object.isFrozen(V010_GOLDENS.positiveOutputs)).toBe(true);
  });
});
