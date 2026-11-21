import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as v from "valibot";
import { createAt, isRandomName, randomName } from "../src/names.ts";
import { child, deepDir, placeB, tempDir } from "./helpers.ts";

const HoldOut = v.object({ ok: v.literal(true), spelt: v.string(), d: v.string() });

describe("names and concurrency", () => {
  // SPEC-routes "D と E": random names are 10 letters and digits from the
  // system's secure generator; sweep tells a D by that form. Every one of
  // the 62 characters shows up, and none other.
  test("random names are 10 of 62 letters and digits", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const n = randomName();
      assert.ok(isRandomName(n), n);
      for (const c of n) {
        seen.add(c);
      }
    }
    assert.equal(seen.size, 62);
    assert.ok(!isRandomName("short"));
    assert.ok(!isRandomName("abcdefghi-"));
  });

  // createAt draws another name when one is taken (EEXIST), up to 16 times,
  // and gives up with that error after.
  test("createAt passes over a taken name and gives up after 16", () => {
    let n = 0;
    const name = createAt(
      () => `n${n++}`,
      (x) => {
        if (x !== "n3") {
          throw Object.assign(new Error("taken"), { code: "EEXIST" });
        }
      },
    );
    assert.equal(name, "n3");
    assert.throws(
      () =>
        createAt(
          () => "x",
          () => {
            throw Object.assign(new Error("taken"), { code: "EEXIST" });
          },
        ),
      { code: "EEXIST" },
    );
  });

  // SPEC "並行": processes starting at once each make their own D in the one
  // B they share, without tripping over each other.
  test("processes at once share B and each make a D of their own", async () => {
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => child({ op: "hold-resolve", path: `${deepDir(tempDir())}/s.sock` }, tempDir())),
    );
    const outs = runs.map((r) => v.parse(HoldOut, r.out));
    assert.equal(new Set(outs.map((o) => o.d)).size, 4);
    for (const o of outs) {
      assert.ok(o.spelt.includes(o.d) || o.spelt.startsWith("/proc/"), o.spelt);
    }
    assert.ok(placeB().length > 0);
    await Promise.all(runs.map((r) => r.end()));
  });
});
