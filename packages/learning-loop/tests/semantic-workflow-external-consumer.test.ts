// Strict package consumer: the setup helper itself imports only supported
// package entrypoints (root, /testing, and /workflows), never src/ deep paths.
import { describe, expect, expectTypeOf, it } from "vitest";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createSemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createGenerationHarness } from "./semantic-workflow-generation-harness.js";

describe("external workflow package consumer", () => {
  it("builds definition, registry, loop, bundle, and prepared plan through supported entrypoints", async () => {
    type RunResult = Awaited<ReturnType<SemanticWorkflowBundle["runGeneration"]>>;
    expectTypeOf<RunResult["status"]>().not.toEqualTypeOf<"execution_existing">();
    expectTypeOf<RunResult["persistence"]>().not.toEqualTypeOf<"existing_execution">();
    const harness = await createGenerationHarness();
    expect(harness.definition.outputSchema).toEqual({
      id: createSemanticWorkflowBundle.generationResultSchema.id,
      version: createSemanticWorkflowBundle.generationResultSchema.version,
      schemaDigest: createSemanticWorkflowBundle.generationResultSchema.schemaDigest,
    });
    await expect(harness.bundle.prepareGeneration(harness.prepareInput)).resolves.toMatchObject({
      status: "prepared",
    });
  });
});
