// Pure path arithmetic: splitting a socket path into its directory and file
// name, comparing paths component by component, and spelling an absolute
// path relative to a working directory. Nothing here touches the file system.

/** The byte length of a path as the kernel sees it (UTF-8). */
export function byteLength(path: string): number {
  return Buffer.byteLength(path, "utf8");
}

export function isAbs(path: string): boolean {
  return path.startsWith("/");
}

/**
 * Splits a socket path into the directory that holds the socket and the
 * socket's file name, by what follows the last '/'. A path that does not end
 * with a name ("dir/", "dir/.", "dir/..", "..") gives null: the kernel would
 * resolve it as a directory, not as a socket file.
 *
 * | path        | directory | file name |
 * |-------------|-----------|-----------|
 * | /d/e/s.sock | /d/e      | s.sock    |
 * | /s.sock     | /         | s.sock    |
 * | s.sock      | .         | s.sock    |
 * | d//s.sock   | d/        | s.sock    |
 */
export function splitPath(path: string): { dir: string; name: string } | null {
  const i = path.lastIndexOf("/");
  let dir: string;
  let name: string;
  if (i === 0) {
    dir = "/";
    name = path.slice(1);
  } else if (i > 0) {
    dir = path.slice(0, i);
    name = path.slice(i + 1);
  } else {
    dir = ".";
    name = path;
  }
  if (name === "" || name === "." || name === "..") {
    return null;
  }
  return { dir, name };
}

/**
 * Splits a path into its components the way the kernel walks it: empty
 * segments and "." are dropped, ".." is kept as it is (it is not interpreted
 * lexically, which would be wrong across symlinks). An absolute path starts
 * with the component "/".
 */
export function components(path: string): string[] {
  const out: string[] = [];
  if (path.startsWith("/")) {
    out.push("/");
  }
  for (const c of path.split("/")) {
    if (c !== "" && c !== ".") {
      out.push(c);
    }
  }
  return out;
}

/**
 * The absolute path folded as a string, component by component: empty
 * segments and "." dropped, ".." dropping the component before it (the
 * root's ".." is the root). Not what the kernel does across a symlink
 * ("a/sym/.." folds to "a", while the kernel goes to the parent of sym's
 * target): the caller checks that the result names the same directory
 * (SPEC-routes "絶対パスの候補の作り方", the $PWD candidate).
 *
 * Design rationale: written out rather than path.resolve / path.normalize,
 * which fold the same way, so that every place that folds ".." is one the
 * checks go with; the routes never fold.
 */
export function foldLexically(path: string): string {
  const out: string[] = [];
  for (const c of path.split("/")) {
    if (c === "" || c === ".") {
      continue;
    }
    if (c === "..") {
      out.pop();
      continue;
    }
    out.push(c);
  }
  return `/${out.join("/")}`;
}

/** Whether a and b are the same spelling component by component. */
export function sameComponents(a: string, b: string): boolean {
  const ca = components(a);
  const cb = components(b);
  return ca.length === cb.length && ca.every((c, i) => c === cb[i]);
}

/**
 * The part of target below the directory prefix, when target starts with
 * prefix component by component ("/a/b" is a prefix of "/a/b/c" but not of
 * "/a/bc"). null when either is not absolute or prefix is not a proper prefix.
 */
export function below(target: string, prefix: string): string | null {
  if (!isAbs(target) || !isAbs(prefix)) {
    return null;
  }
  const t = components(target);
  const p = components(prefix);
  if (t.length <= p.length || !p.every((c, i) => c === t[i])) {
    return null;
  }
  return t.slice(p.length).join("/");
}

/**
 * The absolute path target spelt relative to the absolute directory cwd:
 * climb with ".." out of the part of cwd that target does not share, then
 * descend along the rest of target. Only meaningful when both are real paths
 * (each ".." then climbs out of a real directory, as the kernel does); the
 * caller confirms that the result names the same directory. null when either
 * is not absolute, or target is cwd itself or one of its ancestors.
 */
export function relativeTo(target: string, cwd: string): string | null {
  if (!isAbs(target) || !isAbs(cwd)) {
    return null;
  }
  const t = components(target);
  const c = components(cwd);
  let common = 0;
  while (common < t.length && common < c.length && t[common] === c[common]) {
    common++;
  }
  if (common >= t.length) {
    return null;
  }
  return [...c.slice(common).map(() => ".."), ...t.slice(common)].join("/");
}

/** The entry name of the directory dir. */
export function joinUnder(dir: string, name: string): string {
  return `${dir.endsWith("/") ? dir.slice(0, -1) : dir}/${name}`;
}
