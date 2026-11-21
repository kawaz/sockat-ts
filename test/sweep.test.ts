import assert from "node:assert/strict";
import fs from "node:fs";
import nodePath from "node:path";
import { describe, test } from "node:test";
import * as v from "valibot";
import { sweep, sweepBase } from "../src/index.ts";
import { openLocked } from "../src/lock.ts";
import { randomName } from "../src/names.ts";
import { child, deepDir, listing, placeB, shortDir, tempDir, thrown, world } from "./helpers.ts";
import { resolveForBindIn } from "../src/resolve.ts";

const HoldOut = v.object({ ok: v.literal(true), spelt: v.string(), d: v.string() });

/** A D left by a process that has ended: a directory of D's form, no lock, a symlink in it. */
function deadD(b: string): string {
  const name = randomName();
  fs.mkdirSync(`${b}/${name}`, { mode: 0o711 });
  fs.symlinkSync("/nonexistent", `${b}/${name}/0`);
  return name;
}

describe("sweep", () => {
  // The process's own D holds a lock others see: an exclusive lock on it
  // (as sweep takes, from another open of it) cannot be taken.
  test("the process's D is locked", () => {
    const w = world();
    resolveForBindIn(w, `${deepDir(tempDir())}/s.sock`, {}).cleanup();
    const b = w.auto;
    assert.ok(b !== null && b.d !== null);
    const r = openLocked(nodePath.join(b.real, b.d.name), w.cfg.lock, "exclusive");
    assert.equal(r.ok, false);
  });

  // SPEC "sweep": a D whose process has ended (no lock) goes with its
  // symlinks; the D of a live process (here a child holding it) stays, and
  // so do a D holding anything but symlinks, a symlink right in B, and an
  // entry not named as a D is. Once the child has ended, its D goes too.
  test("sweep removes dead D only", async () => {
    resolveForBindIn(world(), `${deepDir(tempDir())}/s.sock`, {}).cleanup();
    const b = placeB();
    const dead = deadD(b);
    const withFile = randomName();
    fs.mkdirSync(`${b}/${withFile}`);
    fs.writeFileSync(`${b}/${withFile}/f`, "");
    const eInB = randomName();
    fs.symlinkSync("/nonexistent", `${b}/${eInB}`);
    fs.mkdirSync(`${b}/not-a-d`);
    const held = await child({ op: "hold-resolve", path: `${deepDir(tempDir())}/s.sock` }, tempDir());
    const out = v.parse(HoldOut, held.out);
    const entries = (): string[] => listing(b).map((e) => e.replace(/\/$/, "").replace(/ -> .*/, ""));
    assert.ok(entries().includes(out.d));

    sweep();
    const after = entries();
    assert.ok(!after.includes(dead), "the dead D is removed");
    assert.ok(after.includes(out.d), "the live child's D stays");
    assert.ok(after.includes(withFile), "a D with a file in it stays");
    assert.ok(after.includes("not-a-d"));
    assert.ok(after.includes(eInB), "a symlink right in B (a connect's E) stays");
    assert.ok(fs.lstatSync(`${b}/${eInB}`).isSymbolicLink());

    await held.end();
    sweep();
    assert.ok(!entries().includes(out.d), "the D of the child that ended is removed");
  });

  // sweepBase: the same for an Options.base B; nothing for a base whose
  // parent is missing; an argument error for a relative one; EPERM for a
  // symlink.
  test("sweepBase sweeps an Options.base B and checks it", () => {
    const root = shortDir();
    const base = `${root}/b`;
    resolveForBindIn(world(), `${deepDir(tempDir())}/s.sock`, { base }).cleanup();
    const dead = deadD(base);
    sweepBase(base);
    assert.ok(!fs.existsSync(`${base}/${dead}`));
    assert.equal(listing(base).length, 1, "this process's D stays");

    sweepBase(`${root}/no/such/b`);
    assert.ok(thrown(() => sweepBase("rel/b")).error instanceof TypeError);
    fs.symlinkSync(base, `${root}/link`);
    assert.equal(thrown(() => sweepBase(`${root}/link`))["code"], "EPERM");
    // A parent that is not a directory is ENOTDIR, as for Options.base.
    fs.writeFileSync(`${root}/file`, "");
    assert.equal(thrown(() => sweepBase(`${root}/file/b`))["code"], "ENOTDIR");
  });
});
