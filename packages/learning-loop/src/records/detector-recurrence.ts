// Privacy-treated recurrence identity supplied by an exact detector implementation.
import { invalid, parseOneOf, readFields } from "../parse/toolkit.js";
import type { Parse } from "../parse/toolkit.js";
import { parseDigestAt } from "./semantic-shared.js";

const MAX_STRUCTURAL_LABEL_LENGTH = 200;
const STRUCTURAL_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/;
export const DETECTOR_RECURRENCE_GROUP_MEMBER_LIMIT = 5_000;

export type DetectorRecurrenceLocator =
  | { readonly treatment: "public_structural"; readonly structuralLabel: string }
  | {
      readonly treatment: "tenant_keyed_private";
      readonly keyedDigest: string;
      readonly keyPolicyDigest: string;
    };

const parseStructuralLabelAt: Parse<string> = (input, path) => {
  if (typeof input !== "string") {
    throw invalid("schema.invalid", "recurrence structural label must be a string", path);
  }
  if (
    input.length === 0 ||
    input.length > MAX_STRUCTURAL_LABEL_LENGTH ||
    input.normalize("NFKC") !== input ||
    input.toLowerCase() !== input ||
    !STRUCTURAL_LABEL_PATTERN.test(input)
  ) {
    throw invalid("schema.invalid", "recurrence structural label is not a canonical ASCII token", path);
  }
  return input;
};

export const parseDetectorRecurrenceLocatorAt: Parse<DetectorRecurrenceLocator> = (input, path) => {
  const fields = readFields(input, path);
  const treatment = fields.req("treatment", parseOneOf(["public_structural", "tenant_keyed_private"]));
  if (treatment === "public_structural") {
    return {
      treatment,
      structuralLabel: fields.req("structuralLabel", parseStructuralLabelAt),
    };
  }
  return {
    treatment: "tenant_keyed_private",
    keyedDigest: fields.req("keyedDigest", parseDigestAt),
    keyPolicyDigest: fields.req("keyPolicyDigest", parseDigestAt),
  };
};
