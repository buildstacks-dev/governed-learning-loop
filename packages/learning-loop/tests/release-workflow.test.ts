import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(new URL("../../../.github/workflows/release.yml", import.meta.url), "utf8");

describe("release workflow publication gate", () => {
  it("defaults to verify-only and requires an explicit publish dispatch", () => {
    expect(WORKFLOW).toMatch(
      /publish:\n\s+description: "Explicitly allow the publish job after verification"\n\s+required: true\n\s+type: boolean\n\s+default: false/u,
    );
    expect(WORKFLOW).toContain("if: inputs.publish == true");
  });

  it("admits publish intent only from the ratified maintainer", () => {
    expect(WORKFLOW).toContain('[ "$PUBLISH_REQUESTED" = "true" ] && [ "$RELEASE_ACTOR" != "bikramgupta" ]');
    expect(WORKFLOW).toContain("only the ratified maintainer may request publication");
  });

  it("keeps OIDC on the conditional publish job and uses no environment gate", () => {
    expect(WORKFLOW).not.toMatch(/^\s+environment:/mu);
    expect(WORKFLOW.match(/id-token: write/gu)).toHaveLength(1);
    expect(WORKFLOW).toContain('npm publish "$TARBALL" --access public --ignore-scripts');
  });

  it("verifies the tag and dispatch-time main without a post-checkout private fetch", () => {
    const tagCheckoutRef = ["ref: $", "{{ steps.approved.outputs.tag }}"].join("");
    expect(WORKFLOW).toContain(tagCheckoutRef);
    expect(WORKFLOW).toContain('[ "$WORKFLOW_REF" = "refs/heads/main" ]');
    expect(WORKFLOW).toContain('git merge-base --is-ancestor "$APPROVED_COMMIT" "$WORKFLOW_SHA"');
    expect(WORKFLOW).not.toContain("git fetch");
  });
});
