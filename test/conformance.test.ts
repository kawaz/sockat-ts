import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import nodePath from "node:path";
import { describe, test } from "node:test";
import * as v from "valibot";
import { deepDir, runtime, shortDir, tempDir } from "./helpers.ts";

// The conformance CLI (the hub's docs/design/conformance.md): one JSON in,
// one JSON line out, exit 0; an invalid input prints nothing and exits 2.
// Every long path here is given a base of the test's own, so the CLI does
// not touch the real /tmp/sockat-<uid>.

const cli = nodePath.join(import.meta.dirname, "..", "conformance", "cli.ts");

const Output = v.object({
  ok: v.boolean(),
  error: v.nullable(v.string()),
  route: v.nullable(v.string()),
  base: v.nullable(v.string()),
  spelling: v.nullable(v.object({ kind: v.string() })),
  skipped: v.array(v.string()),
});

function run(input: string, cwd: string): { status: number | null; out: string } {
  const r = spawnSync(runtime, [cli], { input, cwd, encoding: "utf8" });
  return { status: r.status, out: r.stdout };
}

describe("conformance CLI", () => {
  // A relative short path binds in the cwd the CLI was started in.
  test("a short relative bind is CwdRelative through the standard", () => {
    const r = run('{"op":"bind","path":"s.sock"}', shortDir());
    assert.equal(r.status, 0);
    const out = v.parse(Output, JSON.parse(r.out));
    assert.deepEqual([out.ok, out.route, out.spelling?.kind, out.skipped], [true, "standard", "CwdRelative", []]);
  });

  // A long path with a base binds through it ("given"), and the argument
  // errors are named invalid-argument with no route and nothing skipped.
  test("a long bind with a base, and an argument error", () => {
    const base = `${shortDir()}/b`;
    const path = `${deepDir(tempDir())}/s.sock`;
    const ok = v.parse(Output, JSON.parse(run(JSON.stringify({ op: "bind", path, base }), tempDir()).out));
    assert.deepEqual([ok.ok, ok.base, ok.spelling?.kind, ok.skipped[0]], [true, "given", "Linked", "standard"]);
    const bad = v.parse(Output, JSON.parse(run(JSON.stringify({ op: "bind", path: `${path}/`, base }), tempDir()).out));
    assert.deepEqual([bad.ok, bad.error, bad.route, bad.skipped], [false, "invalid-argument", null, []]);
  });

  // An input that is not the JSON wanted: nothing on stdout, exit 2.
  test("an invalid input exits 2 with nothing on stdout", () => {
    for (const input of ["garbage", '{"op":"listen","path":"x"}']) {
      const r = run(input, tempDir());
      assert.equal(r.status, 2);
      assert.equal(r.out, "");
    }
  });
});
