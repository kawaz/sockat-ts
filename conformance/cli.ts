// The conformance CLI of sockat-ts (the hub's docs/design/conformance.md,
// "試験用 CLI の決まり"): reads {"op", "path", "usable_cross_uid", "base"}
// from stdin, binds or connects once with bindEx / connectEx and the Options
// given, and writes {"ok", "error", "route", "base", "spelling", "skipped"}
// to stdout. Not part of the package (not in dist/). Runs on Node and Bun.
//
// Neither remove() nor cleanup() is called (the hub looks at what is left in
// the places). A bind's listener is left open for the process's exit, which
// does not unlink it; a connect sends one byte "x" before closing.

import os from "node:os";
import * as v from "valibot";
import { bindEx, connectEx } from "../src/index.ts";
import type { Options, Spelling } from "../src/index.ts";

const Input = v.object({
  op: v.picklist(["bind", "connect"]),
  path: v.string(),
  usable_cross_uid: v.optional(v.boolean(), false),
  base: v.optional(v.nullable(v.string()), null),
});

/** What the errors of bindEx / connectEx carry that the output reports. */
const Diagnosed = v.object({
  route: v.nullable(v.string()),
  skipped: v.array(v.object({ name: v.string() })),
});
const WithCode = v.object({ code: v.string() });

type SpellingOut =
  | { kind: "Original" | "CwdRelative" | "Dangling" }
  | { kind: "Linked"; removable: boolean; until: string; usable_cross_uid: boolean; usable_with_private_tmp: boolean };

interface Output {
  ok: boolean;
  error: string | null;
  route: string | null;
  base: string | null;
  spelling: SpellingOut | null;
  skipped: string[];
}

function spellingOut(s: Spelling): SpellingOut {
  if (s.kind === "Linked") {
    return {
      kind: "Linked",
      removable: s.removable,
      until: s.until,
      usable_cross_uid: s.usableCrossUid,
      usable_with_private_tmp: s.usableWithPrivateTmp,
    };
  }
  return { kind: s.kind };
}

/** The errnos with two names, by the name the conformance output uses. */
const sameErrno: ReadonlyArray<readonly [string, string]> = [
  ["EWOULDBLOCK", "EAGAIN"],
  ["ENOTSUP", "EOPNOTSUPP"],
  ["EDEADLOCK", "EDEADLK"],
];

/**
 * The output's error name: invalid-argument for an argument error, the
 * errno's C name (EAGAIN, EOPNOTSUPP and EDEADLK for the values with two
 * names), errno-<n> for an errno without a name, general otherwise.
 */
function errorName(e: unknown): string {
  const c = v.safeParse(WithCode, e);
  if (!c.success) {
    return "general";
  }
  const code = c.output.code;
  if (code === "ERR_INVALID_ARG_VALUE") {
    return "invalid-argument";
  }
  if (!/^E[A-Z0-9]+$/.test(code)) {
    return /^Unknown system error -?\d+$/.test(code) ? `errno-${code.replace(/\D/g, "")}` : "general";
  }
  const errnos = new Map<string, number>(Object.entries(os.constants.errno));
  for (const [alias, name] of sameErrno) {
    if (code === alias && errnos.get(alias) === errnos.get(name)) {
      return name;
    }
  }
  return code;
}

function failure(e: unknown): Output {
  const d = v.safeParse(Diagnosed, e);
  return {
    ok: false,
    error: errorName(e),
    route: d.success ? d.output.route : null,
    base: null,
    spelling: null,
    skipped: d.success ? d.output.skipped.map((s) => s.name) : [],
  };
}

async function readStdin(): Promise<string> {
  let s = "";
  for await (const chunk of process.stdin) {
    s += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  }
  return s;
}

function parseInput(text: string): v.InferOutput<typeof Input> | null {
  try {
    const r = v.safeParse(Input, JSON.parse(text));
    return r.success ? r.output : null;
  } catch {
    return null;
  }
}

const input = parseInput(await readStdin());
if (input === null) {
  process.stderr.write('sockat-ts conformance: want {"op": "bind"|"connect", "path": ..., "usable_cross_uid": true|false, "base": null|...} on stdin\n');
  process.exit(2);
}
const opts: Options = input.base === null ? { usableCrossUid: input.usable_cross_uid } : { usableCrossUid: input.usable_cross_uid, base: input.base };

let out: Output;
if (input.op === "bind") {
  try {
    const b = await bindEx(input.path, opts);
    out = {
      ok: true,
      error: null,
      route: b.route,
      base: b.base,
      spelling: spellingOut(b.spelling),
      skipped: b.skipped.map((s) => s.name),
    };
  } catch (e) {
    out = failure(e);
  }
} else {
  try {
    const c = await connectEx(input.path, opts);
    await new Promise<void>((resolve) => {
      c.socket.once("error", () => resolve());
      c.socket.end("x", () => resolve());
    });
    out = { ok: true, error: null, route: c.route, base: null, spelling: null, skipped: c.skipped.map((s) => s.name) };
  } catch (e) {
    out = failure(e);
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`, () => process.exit(0));
