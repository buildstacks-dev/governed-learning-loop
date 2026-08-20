// Public exact-scope workflow audit reads and opaque cursor controls.
import { describe, expect, it } from "vitest";
import type { SemanticWorkflowBundle } from "@cormidia/learning-loop/workflows";
import { createInMemoryStore } from "@cormidia/learning-loop/testing";
import { scopeDigest, sha256HexOfCanonicalJson, toJsonValue } from "@cormidia/learning-loop";
import {
  createGenerationHarness,
  ingestWorkflowEpisode,
  recordingStore,
} from "./semantic-workflow-generation-harness.js";
import type { StoreMutationTrace } from "./semantic-workflow-generation-harness.js";

async function prepareAndRun(
  bundle: SemanticWorkflowBundle,
  input: Parameters<SemanticWorkflowBundle["prepareGeneration"]>[0],
) {
  const prepared = await bundle.prepareGeneration(input);
  if (prepared.status !== "prepared") throw new Error(`expected prepared workflow, got ${prepared.status}`);
  return bundle.runGeneration({ plan: prepared.plan, authorization: null });
}

async function collect<T>(iterable: AsyncIterable<{ readonly items: readonly T[] }>): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const page of iterable) items.push(...page.items);
  return items;
}

async function firstPage<T>(iterable: AsyncIterable<T>): Promise<T> {
  for await (const page of iterable) return page;
  throw new Error("workflow query returned no page");
}

describe("public semantic workflow exact-scope reads", () => {
  it("gets one completed inert turn only in its exact scope with minimized disclosure projection", async () => {
    const base = createInMemoryStore();
    const trace: StoreMutationTrace = { writes: [], reads: [], lists: [] };
    const harness = await createGenerationHarness({ store: recordingStore(base, trace) });
    const result = await prepareAndRun(harness.bundle, harness.prepareInput);
    if (result.turnId === null) throw new Error("completed workflow omitted turn id");
    const view = await harness.bundle.getTurn({ turnId: result.turnId, scope: harness.scope });
    expect(view).toMatchObject({
      id: result.turnId,
      definition: { definitionDigest: harness.definition.definitionDigest },
      transport: "local",
      status: "completed",
      authorization: { status: "not_required" },
      disclosure: { status: "result_attested" },
      output: { kind: "generation" },
    });
    expect(JSON.stringify(view)).not.toMatch(/rawResponse|providerError|Candidate|Review|publication|effect/);
    if (trace.reads === undefined || trace.lists === undefined) throw new Error("scope-read fixture omitted traces");
    trace.reads.length = 0;
    trace.lists.length = 0;
    await expect(
      harness.bundle.getTurn({
        turnId: result.turnId,
        scope: [{ type: "project", id: "foreign-project" }],
      }),
    ).resolves.toBeUndefined();
    expect(trace.reads.length).toBeGreaterThan(0);
    expect(trace.reads.every((key) => key.namespace !== "learning")).toBe(true);
    expect(trace.lists).toEqual([]);

    trace.reads.length = 0;
    trace.lists.length = 0;
    await expect(
      collect(
        harness.bundle.queryTurns({
          scope: [{ type: "project", id: "foreign-project" }],
          limit: 10,
        }),
      ),
    ).resolves.toEqual([]);
    expect(trace.reads).toEqual([]);
    expect(trace.lists.length).toBeGreaterThan(0);
    expect(trace.lists.every((query) => query.namespace !== "learning")).toBe(true);
  });

  it("paginates two same-scope turns with opaque resumable cursors and no duplicates", async () => {
    const harness = await createGenerationHarness();
    const first = await prepareAndRun(harness.bundle, harness.prepareInput);
    const secondEpisodeIds = await ingestWorkflowEpisode(harness, "semantic-workflow-second");
    const second = await prepareAndRun(harness.bundle, {
      ...harness.prepareInput,
      episodeRecordIds: secondEpisodeIds,
    });
    expect(first.turnId).not.toBe(second.turnId);
    const page1 = await firstPage(harness.bundle.queryTurns({ scope: harness.scope, limit: 1 }));
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeDefined();
    if (page1.nextCursor === undefined) throw new Error("two-turn query omitted its cursor");
    const page2 = await firstPage(
      harness.bundle.queryTurns({ scope: harness.scope, cursor: page1.nextCursor, limit: 2 }),
    );
    expect(page2.items).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
    expect(new Set([...page1.items, ...page2.items].map((item) => item.id))).toEqual(
      new Set([first.turnId, second.turnId]),
    );
    expect(page1.snapshotRevision).not.toBe("");
    expect(page2.snapshotRevision).not.toBe("");
  });

  it("binds cursors to exact scope, definition, store, and canonical encoding", async () => {
    const harness = await createGenerationHarness();
    await prepareAndRun(harness.bundle, harness.prepareInput);
    const secondEpisodeIds = await ingestWorkflowEpisode(harness, "semantic-workflow-cursor-second");
    await prepareAndRun(harness.bundle, { ...harness.prepareInput, episodeRecordIds: secondEpisodeIds });
    const page = await firstPage(harness.bundle.queryTurns({ scope: harness.scope, limit: 1 }));
    if (page.nextCursor === undefined) throw new Error("cursor fixture omitted its cursor");
    expect(() =>
      harness.bundle.queryTurns({
        scope: [{ type: "project", id: "foreign-project" }],
        cursor: page.nextCursor,
        limit: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^query\.|^schema\./) }));
    expect(() =>
      harness.bundle.queryTurns({
        scope: harness.scope,
        cursor: `${page.nextCursor}x`,
        limit: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: expect.stringMatching(/^query\.|^schema\./) }));

    const other = await createGenerationHarness({ queryCursorScope: "other-workflow-store" });
    expect(() => other.bundle.queryTurns({ scope: other.scope, cursor: page.nextCursor, limit: 1 })).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/^query\.|^schema\./) }),
    );
  });

  it("returns one bounded empty page for an exact scope with no workflow facts", async () => {
    const harness = await createGenerationHarness();
    const pages = await collect(harness.bundle.queryTurns({ scope: harness.scope, limit: 10 }));
    expect(pages).toEqual([]);
    const page = await firstPage(harness.bundle.queryTurns({ scope: harness.scope, limit: 10 }));
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.snapshotRevision).not.toBe("");
  });

  it("accepts query limits 1 and 100 and rejects every adjacent or non-integer boundary", async () => {
    const harness = await createGenerationHarness();
    await expect(firstPage(harness.bundle.queryTurns({ scope: harness.scope, limit: 1 }))).resolves.toMatchObject({
      items: [],
    });
    await expect(firstPage(harness.bundle.queryTurns({ scope: harness.scope, limit: 100 }))).resolves.toMatchObject({
      items: [],
    });
    for (const limit of [0, 101, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => harness.bundle.queryTurns({ scope: harness.scope, limit })).toThrowError(
        expect.objectContaining({ code: "schema.invalid" }),
      );
    }
    expect(() =>
      harness.bundle.queryTurns({ scope: harness.scope, limit: 1, cursor: "x".repeat(16_385) }),
    ).toThrowError(expect.objectContaining({ code: "query.cursor_invalid" }));
  });

  it("isolates same-scope definition corruption, cursor work, and revisions before global reads", async () => {
    const base = createInMemoryStore();
    const trace: StoreMutationTrace = { writes: [], reads: [], lists: [] };
    const harness = await createGenerationHarness({ store: recordingStore(base, trace) });
    const first = await prepareAndRun(harness.bundle, harness.prepareInput);
    const secondEpisodeIds = await ingestWorkflowEpisode(harness, "definition-isolation-second");
    const second = await prepareAndRun(harness.bundle, {
      ...harness.prepareInput,
      episodeRecordIds: secondEpisodeIds,
    });
    const firstPageValue = await firstPage(harness.bundle.queryTurns({ scope: harness.scope, limit: 1 }));
    if (firstPageValue.nextCursor === undefined) throw new Error("definition isolation fixture omitted its cursor");
    const foreign = await createGenerationHarness({ maximumOutputTokens: 2_001 });
    expect(foreign.definition.definitionDigest).not.toBe(harness.definition.definitionDigest);
    const exactScopeDigest = scopeDigest(harness.scope);
    const scopeNamespace = `learning-semantic-workflow-scope-${exactScopeDigest}`;
    const localDefinitionNamespace = `${scopeNamespace}-definition-${harness.definition.definitionDigest}`;
    const foreignNamespace = `${scopeNamespace}-definition-${foreign.definition.definitionDigest}`;
    const foreignTurnId = `semantic-workflow-turn-${"f".repeat(64)}`;
    const corruptValue = toJsonValue({ schemaVersion: 1, corruptForeignDefinitionCanary: true });
    await harness.store.create(
      { namespace: foreignNamespace, kind: "semantic-workflow-turn", id: foreignTurnId },
      corruptValue,
      sha256HexOfCanonicalJson(corruptValue),
      "seed-foreign-definition-corruption",
    );
    await harness.store.create(
      { namespace: scopeNamespace, kind: "semantic-workflow-turn-index", id: foreignTurnId },
      corruptValue,
      sha256HexOfCanonicalJson(corruptValue),
      "seed-foreign-shared-index-corruption",
    );
    if (trace.reads === undefined || trace.lists === undefined) throw new Error("definition isolation traces absent");
    trace.reads.length = 0;
    trace.lists.length = 0;
    const secondPageValue = await firstPage(
      harness.bundle.queryTurns({
        scope: harness.scope,
        cursor: firstPageValue.nextCursor,
        limit: 2,
      }),
    );
    expect(secondPageValue.items).toHaveLength(1);
    expect(new Set([...firstPageValue.items, ...secondPageValue.items].map((item) => item.id))).toEqual(
      new Set([first.turnId, second.turnId]),
    );
    expect(secondPageValue.snapshotRevision).toBe(firstPageValue.snapshotRevision);
    expect(
      trace.lists.every((query) => query.namespace !== foreignNamespace && query.namespace !== scopeNamespace),
    ).toBe(true);
    expect(
      trace.reads.every(
        (key) => key.namespace !== foreignNamespace && !(key.namespace === scopeNamespace && key.id === foreignTurnId),
      ),
    ).toBe(true);

    trace.reads.length = 0;
    trace.lists.length = 0;
    await expect(harness.bundle.getTurn({ turnId: foreignTurnId, scope: harness.scope })).resolves.toBeUndefined();
    expect(trace.reads.length).toBeGreaterThan(0);
    expect(trace.reads.every((key) => key.namespace === localDefinitionNamespace)).toBe(true);
    expect(trace.lists).toEqual([]);
  });
});
