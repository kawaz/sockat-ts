# sockat-ts justfile
#
# README は ja が正本、en が翻訳先。push 時に check-outdated-translations が
# 「en が ja より古い」を止める。VCS 操作は bump-semver vcs に委譲する。
#
# 試験は src/ と test/ の .ts を Node (22.18 以上は型を剥がして走らせる) と
# Bun がそのまま走らせる。dist/ は package に入れる物で、試験は使わない。

set shell := ["bash", "-euo", "pipefail", "-c"]

set positional-arguments

# default: list
default: list

# show recipes
list:
    @just --list --unsorted

# ---------- build / lint / test ----------

# dist/ に JS と .d.ts を作る
build:
    rm -rf dist
    ./node_modules/.bin/tsc -p tsconfig.build.json

# oxlint と型の検査 (src・test・conformance)
lint:
    ./node_modules/.bin/oxlint --deny-warnings
    ./node_modules/.bin/tsc -p tsconfig.json

# 試験を Node と Bun の両方で回す (ARGS は両方に渡す試験のファイル)
test *ARGS: (test-node ARGS) (test-bun ARGS)

# 試験を Node で回す
test-node *ARGS:
    node --test {{ if ARGS == "" { "'test/**/*.test.ts'" } else { ARGS } }}

# 試験を Bun で回す
test-bun *ARGS:
    bun test {{ if ARGS == "" { "./test/" } else { ARGS } }}

# Linux の試験を docker で回す (Node 22・24・26 と Bun。glibc の Debian と、Bun は busybox の alpine も)
#
# ソースを $TMPDIR の下 (mktemp -d) に写し、そこだけを mount する (リポは mount しない)。
# 試験が使う依存は valibot (test/ の子プロセスの入出力) だけなので、node_modules はそれだけを写す。
[doc("Linux の試験を docker で回す (Node 22・24・26、Bun の Debian と alpine)")]
test-linux:
    #!/usr/bin/env bash
    set -euo pipefail
    work=$(mktemp -d "${TMPDIR:-/tmp}/stt-linux.XXXXXX")
    trap 'rm -rf "$work"' EXIT
    cp -R src test package.json "$work"/
    mkdir -p "$work/node_modules"
    cp -R node_modules/valibot "$work/node_modules/"
    status=0
    for image in node:22-slim node:24-slim node:26-slim; do
      echo "== $image"
      docker run --rm -v "$work":/work -w /work "$image" node --test 'test/**/*.test.ts' || status=1
    done
    for image in oven/bun:1.4.4 oven/bun:1.4.4-alpine; do
      echo "== $image"
      docker run --rm -v "$work":/work -w /work "$image" bun test ./test/ || status=1
    done
    exit $status

# ---------- 適合試験 (ハブの docs/design/conformance.md) ----------

# 適合試験の CLI が使う依存 (valibot) を入れる
conformance-build:
    bun install --frozen-lockfile

# 適合試験の CLI を起こす。標準入力の JSON 1 つで 1 回 bind / connect し、結果の JSON を標準出力に出す。cwd と環境は呼んだ所のまま。runtime は node か bun
[no-cd]
conformance runtime="node":
    @exec {{ runtime }} {{ quote(justfile_directory() / "conformance" / "cli.ts") }}

# ---------- gates (push の内部) ----------

# uncommitted change がない状態か確認
[private]
ensure-clean:
    bump-semver vcs is clean

# 現在の bookmark/branch が default (= main) 上にあるか確認
[private]
check-on-default-branch:
    bump-semver vcs is on-default-branch

# 翻訳ペアの鮮度 (正本 = *-ja.md、翻訳先 = 同じ場所の *.md)
[private]
check-outdated-translations: ensure-clean
    bump-semver vcs outdated 'glob:**/*-ja.md' '$1/$2.md'

# package が組めるか (dist を作ってから)
check: build
    bun pm pack --dry-run

# ---------- flow ----------

# 現在の worktree を default branch (= origin/<default>) に rebase
sync:
    bump-semver vcs sync --onto $(bump-semver vcs get default-branch)@origin

# push (gate を全部通してから)。package.json の version を上げた push で Release が registry に出す
push: check-on-default-branch ensure-clean check-outdated-translations lint test check
    bump-semver vcs push --branch main --jj-bookmark-auto-advance
