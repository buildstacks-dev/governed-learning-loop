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
      derivationDigest: "feaebe651a838806fc6e79500e162469f99698f0df5c2a13defbbaae805493af",
      executionKeyDigest: "502174e06cd50ebd96fb100277ab124b2a8dbe4dc372081b4beac813d5d20c37",
      executionDigest: "15fb8ea65a638b0472148d7a53d44b2cb28e86e95264f7076dd715476b4bbb2f",
    },
    {
      family: "context_pressure_compaction",
      derivationDigest: "03ea6bf2c095eacd431e14673a231fd7a00b70124399541855ff9eca96bc77bc",
      executionKeyDigest: "42443c43b0d16c59734ed6855a503278a8d73ab342be406921a147bc5143a6b8",
      executionDigest: "19da6d9b81f03d3761b94285efe929a3a915f70b276fe85225563cba07c79467",
    },
    {
      family: "coordination_attribution_integrity",
      derivationDigest: "eb06cfb3a535bba5f76933b2dae709b8ffb281449712064b1fb886789498d728",
      executionKeyDigest: "1f39ba4a09b3e0ebae925dc6578e5cce3f8a9858acbb239740153381f8a25264",
      executionDigest: "4b6f8cba64112f2a131ae38d07e053e902fee1de69e3fb10b16ad58742c91b8b",
    },
    {
      family: "coordination_fanout",
      derivationDigest: "e4a07a32c8f3c2482e41830bf174b3722c4cdeaca7089521dfb4eaf9d3d07632",
      executionKeyDigest: "22f7861015778e3422f456aa2a7c096953ffe87dfec4e7eb1b08627638a33895",
      executionDigest: "168eb22baa2fd3c2608878ebc815f6e154cb2fa1d0504c5fcfccc184111a4c34",
    },
    {
      family: "repeated_status_polling",
      derivationDigest: "2d9b2f60b65e3a21d1c672a5bfe55905a27a8df1f2b40dd760009dbf277fbfa8",
      executionKeyDigest: "0afa0f23c649dfec2dcefbc9e7873db2c1e7be91d52c094e1d4dbd86a343507f",
      executionDigest: "668f009a3b749e7179c17bbf622cdad9f7b50efa738659d3e70d849739145e9e",
    },
    {
      family: "tool_use_concentration",
      derivationDigest: "a2dad03563d8ac050945a0d64af1ac8bd918e41c0d17ad01b47abe9b2c49b275",
      executionKeyDigest: "c3e7f5d629792480b68a7673aa04640348b745321adb03db98722d17d8ec46e1",
      executionDigest: "ec48321b19e9bbd31164df86b5c671137c91a86a3a13b38538cf92921c40c44b",
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
