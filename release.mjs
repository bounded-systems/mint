// release.mjs — the pure provenance core of `mint release`.
//
// releaseStatement() is a PURE function of (version, tag, commit, date,
// changelog, producer, builder): no filesystem, no clock, no randomness. The
// same inputs always produce a byte-identical in-toto Statement — sha in → sha
// out, like plan(). It binds three things into one signable record:
//
//     tag  →  version plan  →  commit
//
// i.e. "this annotated tag names exactly this version, whose changelog is the
// byte-exact output mint's deterministic plan() rendered, cut at this commit."
//
// SHAPE: an in-toto Statement v1 + DSSE pre-authentication encoding — the SAME
// Statement/DSSE/keyless-Sigstore shape the bounded-systems sites and
// @bounded-systems/verify already produce and verify, so a mint release record
// verifies with the SAME tooling (`cosign verify-blob`, sigstore-js). The
// constants below are deliberately the ones @bounded-systems/anchored-chain's
// in-toto module pins, so the artifacts are interoperable.
//
// WHY NOT depend on @bounded-systems/anchored-chain directly: it HAS an in-toto
// module (src/in-toto.ts) but it is Phase-0 and deliberately NOT re-exported
// from its public surface (pinned by import-surface.test.ts); it is bun/
// TypeScript with a `tsc` build step and an @bounded-systems/cas dependency; and
// its predicate models a *derivation chain*, not a release. mint stays a
// zero-build node ESM package, so it mirrors the shape here and can adopt
// anchored-chain's Signer/Verifier once that surface goes public — no churn at
// the boundary, because the bytes already match.
import { createHash } from "node:crypto";
import { z } from "zod";

/** Standard in-toto Statement v1 type URI (matches anchored-chain). */
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
/** mint's release predicate type URI. */
export const RELEASE_PREDICATE_TYPE = "https://bounded.tools/mint/Release/v0.1";
/** DSSE payload type for in-toto Statement JSON (matches anchored-chain). */
export const DSSE_PAYLOAD_TYPE = "application/vnd.in-toto+json";

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// Canonical JSON: object keys sorted recursively, no insignificant whitespace —
// the same value serialises to the same bytes regardless of key insertion order,
// so the digest and the DSSE payload are stable. (Mirrors anchored-chain's
// canonicalJson contract.)
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

// v<semver> — the only tag shape mint cuts. Kept in lockstep with `v${version}`
// in mint.mjs so a malformed version can never become a malformed tag silently.
const Tag = z
  .string()
  .regex(/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, "tag must be v<semver>");
// A git object id (sha1 today, sha256 under SHA-256 repos), or its short form.
const GitObjectId = z.string().regex(/^[0-9a-f]{7,64}$/, "commit must be a hex git object id");

// The CI signing identity (keyless OIDC). Present only in CI; null locally.
// Mirrors the `builder` block the bounded-systems sites publish in provenance.json.
export const Builder = z.object({
  repository: z.string(),
  commit: z.string(),
  ref: z.string(),
  runId: z.string(),
  workflowRef: z.string(),
  issuer: z.string(),
});

export const ReleaseInput = z.object({
  version: z.string().min(1),
  tag: Tag,
  commit: GitObjectId,
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD (injected, never wall-clock)"),
  changelog: z.string().min(1, "changelog entry must not be empty (run `mint version` first)"),
  producer: z.string().min(1),
  builder: Builder.nullable().default(null),
});

/**
 * Pure: build the in-toto Statement v1 binding tag → version plan → commit.
 * Throws (via Zod) on any malformed input — a release record is fail-closed.
 */
export function releaseStatement(input) {
  const { version, tag, commit, date, changelog, producer, builder } = ReleaseInput.parse(input);
  return {
    _type: STATEMENT_TYPE,
    // The subject IS the tag, anchored to the commit it points at (in-toto's
    // standard `gitCommit` digest algorithm).
    subject: [{ name: tag, digest: { gitCommit: commit } }],
    predicateType: RELEASE_PREDICATE_TYPE,
    predicate: {
      version,
      tag,
      commit,
      date,
      producer,
      // The version plan, bound by the byte-exact changelog entry mint rendered.
      // Re-deriving plan() over the same intents reproduces this digest — that is
      // the "version plan → tag" link, machine-checkable offline.
      plan: {
        changelog,
        digest: { sha256: sha256hex(changelog) },
      },
      // null ⇒ produced locally and UNSIGNED; signing is CI-only (keyless OIDC).
      builder: builder ?? null,
    },
  };
}

/**
 * DSSE pre-authentication encoding (PAE) over the canonical Statement — the exact
 * bytes a DSSE/Sigstore signer signs. Same scheme as anchored-chain, so a mint
 * release envelope is a well-formed DSSE envelope.
 */
export function dssePAE(statement) {
  const payload = Buffer.from(canonicalize(statement), "utf8");
  const t = DSSE_PAYLOAD_TYPE;
  return Buffer.concat([
    Buffer.from(`DSSEv1 ${t.length} ${t} ${payload.length} `, "utf8"),
    payload,
  ]);
}

/** sha256 (hex) of the canonical Statement — a stable id for the release record. */
export function statementDigest(statement) {
  return sha256hex(canonicalize(statement));
}
