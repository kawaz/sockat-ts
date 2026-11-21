# sockat-ts justfile
#
# README は ja が正本、en が翻訳先。push 時に check-outdated-translations が
# 「en が ja より古い」を止める。VCS 操作は bump-semver vcs に委譲する。

set shell := ["bash", "-euo", "pipefail", "-c"]

# default: list
default: list

# show recipes
list:
    @just --list --unsorted

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

# package が組めるか
check:
    bun pm pack --dry-run

# ---------- flow ----------

# 現在の worktree を default branch (= origin/<default>) に rebase
sync:
    bump-semver vcs sync --onto $(bump-semver vcs get default-branch)@origin

# push (gate を全部通してから)。package.json の version を上げた push で Release が npm に出す
push: check-on-default-branch ensure-clean check-outdated-translations check
    bump-semver vcs push --branch main --jj-bookmark-auto-advance
