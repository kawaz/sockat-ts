import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { below, components, relativeTo, sameComponents, splitPath } from "../src/paths.ts";

describe("paths", () => {
  // splitPath splits on the bytes after the last '/', so a path ending with
  // "/", "/." or "/.." has no file name: the kernel would take it as the
  // directory itself, and sockat must refuse it rather than retarget it.
  test("splitPath splits off the file name and refuses a path not ending with one", () => {
    assert.deepEqual(splitPath("/d/e/s.sock"), { dir: "/d/e", name: "s.sock" });
    assert.deepEqual(splitPath("/s.sock"), { dir: "/", name: "s.sock" });
    assert.deepEqual(splitPath("s.sock"), { dir: ".", name: "s.sock" });
    assert.deepEqual(splitPath("d//s.sock"), { dir: "d/", name: "s.sock" });
    for (const p of ["d/", "d/.", "d/..", "..", ".", "/"]) {
      assert.equal(splitPath(p), null, p);
    }
  });

  // components drops empty segments and "." but keeps "..", which is not
  // lexically resolvable across symlinks.
  test("components walks a path as the kernel does", () => {
    assert.deepEqual(components("/a//b/./c/"), ["/", "a", "b", "c"]);
    assert.deepEqual(components("a/../b"), ["a", "..", "b"]);
    assert.ok(sameComponents("/tmp/", "/tmp"));
    assert.ok(!sameComponents("/private/tmp", "/tmp"));
  });

  // below and relativeTo are the arithmetic of the relative route: the result
  // must name the target from the cwd, and nothing when the target is the cwd
  // or above it (no file name would be left).
  test("below and relativeTo spell a path from a directory", () => {
    assert.equal(below("/a/b/c", "/a/b"), "c");
    assert.equal(below("/a/bc", "/a/b"), null);
    assert.equal(below("/a/b", "/a/b"), null);
    assert.equal(relativeTo("/a/b/c/s", "/a/x/y"), "../../b/c/s");
    assert.equal(relativeTo("/a/b/s", "/a/b"), "s");
    assert.equal(relativeTo("/a", "/a/b"), null);
  });
});
