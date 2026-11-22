import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
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

/** A bind request, with a base of the test's own should a route be taken. */
function bind(path: string): string {
  return JSON.stringify({ op: "bind", path, base: `${shortDir()}/b` });
}

function run(input: string, cwd: string, pwd?: string): { status: number | null; out: string } {
  const r = spawnSync(runtime, [cli], { input, cwd, encoding: "utf8", env: { ...process.env, PWD: pwd ?? cwd } });
  return { status: r.status, out: r.stdout };
}

describe("conformance CLI", () => {
  // A relative short path binds in the cwd the CLI was started in, made
  // absolute (DR-0019): through the standard, Original. The hub's scenes
  // start the CLI in a cwd through a symlink and with a $PWD of their own:
  // the CLI reads $PWD from its environment, so a short symlink to a long
  // directory (whose real path does not fit) binds through $PWD, and a
  // $PWD that is not the cwd does not (the routes).
  test("a short relative bind is made absolute, by $PWD when it names the cwd", () => {
    const plain = v.parse(Output, JSON.parse(run(bind("s.sock"), shortDir()).out));
    assert.deepEqual([plain.ok, plain.route, plain.spelling?.kind, plain.skipped], [true, "standard", "Original", []]);
    const link = `${shortDir()}/l`;
    fs.symlinkSync(deepDir(tempDir()), link);
    const viaPwd = v.parse(Output, JSON.parse(run(bind("s.sock"), link).out));
    assert.deepEqual([viaPwd.ok, viaPwd.route, viaPwd.spelling?.kind, viaPwd.skipped], [true, "standard", "Original", []]);
    const stale = v.parse(Output, JSON.parse(run(bind("t.sock"), link, shortDir()).out));
    assert.deepEqual([stale.ok, stale.route, stale.spelling?.kind, stale.skipped[0]], [true, "link-dir", "Linked", "standard"]);
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
