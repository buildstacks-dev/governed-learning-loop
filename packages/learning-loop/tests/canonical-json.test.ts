import { describe, expect, it } from "vitest";
import { canonicalJsonText, sha256HexOfCanonicalJson } from "../src/canonical/canonical-json.js";
import type { JsonValue } from "../src/canonical/json.js";
import { toJsonValue } from "../src/canonical/to-json-value.js";
import { LearningLoopError } from "../src/diagnostics.js";

// Golden vectors: exact canonical text AND exact SHA-256 hex, pinned. Any
// drift here is a protocol break, not a refactor.
const goldenVectors: readonly { name: string; value: JsonValue; canonical: string; sha256: string }[] = [
  {
    name: "object keys sort by UTF-16 code units",
    value: { b: 1, a: 2, aa: 3, A: 4 },
    canonical: '{"A":4,"a":2,"aa":3,"b":1}',
    sha256: "9c0f43adde6d436733e8bc3f11edbe1ec08de15dbc823e44031254212cf3b83a",
  },
  {
    name: "nested arrays and objects sort recursively",
    value: { outer: [{ z: [1, [2, [3]]], a: { b: [] } }, [], {}] },
    canonical: '{"outer":[{"a":{"b":[]},"z":[1,[2,[3]]]},[],{}]}',
    sha256: "251b235bbabbbb3a7f8036006fde896fba3b408404cebcff2f0d2758a28d294a",
  },
  {
    name: "unicode stays literal; control characters escape",
    value: { "€": "é snowman ☃", tab: "a\tb", nul: "a\u0000b", quote: 'say "hi"' },
    canonical: '{"nul":"a\\u0000b","quote":"say \\"hi\\"","tab":"a\\tb","€":"é snowman ☃"}',
    sha256: "ee5aac2c29d3b32e4b64f055f388e4e8a11237abb009364289570ec6fd66de19",
  },
  {
    name: "numbers use ECMAScript shortest rendering; -0 renders 0",
    value: { big: 1e21, small: 1e-7, tenth: 0.1, negzero: -0, maxint: 9007199254740991, negative: -25 },
    canonical: '{"big":1e+21,"maxint":9007199254740991,"negative":-25,"negzero":0,"small":1e-7,"tenth":0.1}',
    sha256: "6eba084e442224baa7e98c3dc41bbcb335599baf6cc6c5ed8cc52dbabd76afcd",
  },
  {
    name: "empty object",
    value: {},
    canonical: "{}",
    sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  },
  {
    name: "empty array",
    value: [],
    canonical: "[]",
    sha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
  },
  {
    name: "JSON literals",
    value: [null, true, false],
    canonical: "[null,true,false]",
    sha256: "37257214f22b92121c5ff4d7e29ed2d31b3f1129ee698e96e581ec05cb2e3cf7",
  },
];

describe("canonical JSON golden vectors", () => {
  for (const vector of goldenVectors) {
    it(vector.name, () => {
      expect(canonicalJsonText(vector.value)).toBe(vector.canonical);
      expect(sha256HexOfCanonicalJson(vector.value)).toBe(vector.sha256);
    });
  }

  it("canonical text is insensitive to insertion order", () => {
    expect(canonicalJsonText({ z: 1, a: { y: 2, b: 3 } })).toBe(canonicalJsonText({ a: { b: 3, y: 2 }, z: 1 }));
  });
});

describe("toJsonValue", () => {
  it("returns an independent copy of valid input", () => {
    const input = { list: [1, "two", null], nested: { ok: true } };
    const value = toJsonValue(input);
    expect(value).toEqual(input);
    expect(value).not.toBe(input);
  });

  const rejected: readonly { name: string; make: () => unknown }[] = [
    { name: "NaN", make: () => ({ n: Number.NaN }) },
    { name: "Infinity", make: () => [Number.POSITIVE_INFINITY] },
    { name: "bigint", make: () => ({ n: 1n }) },
    { name: "function", make: () => ({ f: () => 1 }) },
    { name: "symbol value", make: () => ({ s: Symbol("x") }) },
    { name: "symbol key", make: () => ({ [Symbol("k")]: 1 }) },
    { name: "undefined property value", make: () => ({ u: undefined }) },
    { name: "Date", make: () => ({ d: new Date(0) }) },
    { name: "Map", make: () => ({ m: new Map() }) },
    { name: "Set", make: () => ({ s: new Set() }) },
    { name: "binary buffer", make: () => ({ b: new Uint8Array([1, 2]) }) },
    { name: "class instance", make: () => ({ c: new (class Widget {})() }) },
    {
      name: "sparse array hole",
      make: () => {
        const sparse: unknown[] = [1];
        sparse[2] = 3;
        return sparse;
      },
    },
    {
      name: "cyclic value",
      make: () => {
        const node: { self?: unknown } = {};
        node.self = node;
        return node;
      },
    },
  ];

  for (const { name, make } of rejected) {
    it(`rejects ${name} with a typed schema.invalid error`, () => {
      let caught: unknown;
      try {
        toJsonValue(make());
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(LearningLoopError);
      if (caught instanceof LearningLoopError) {
        expect(caught.code).toBe("schema.invalid");
        expect(caught.diagnostics.length).toBeGreaterThan(0);
      }
    });
  }

  it("reports the path to the offending value", () => {
    let caught: unknown;
    try {
      toJsonValue({ a: [{ b: Number.NaN }] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LearningLoopError);
    if (caught instanceof LearningLoopError) {
      expect(caught.diagnostics[0]?.path).toEqual(["a", 0, "b"]);
    }
  });

  it("accepts -0 and finite extremes", () => {
    expect(toJsonValue({ z: -0, min: Number.MIN_VALUE, max: Number.MAX_VALUE })).toEqual({
      z: -0,
      min: Number.MIN_VALUE,
      max: Number.MAX_VALUE,
    });
  });
});
