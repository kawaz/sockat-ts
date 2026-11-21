---
title: CI に BSD・illumos の job を足すか
status: open
category: task
created: 2026-11-21
---

# CI に BSD・illumos の job を足すか

ハブの AGENTS.md は、パッチ版を出す条件を「CI (BSD・illumos を含む) とハブの適合試験 (全言語) を通す」とする (kawaz 2026-11-21、PB-Q2 = a)。sockat-ts の CI は ubuntu と macos (Bun と Node 22・24・26) だけで、FreeBSD・NetBSD・OpenBSD・illumos では一度も動かしていない。

## 調べること

- Node と Bun が各 OS で動く範囲 (Bun は FreeBSD 等を公式に出していない見込み。Node は FreeBSD の ports、illumos の pkgsrc 等)
- sockat-rs・sockat-go の CI の VM の job (vmactions 等) を、Node だけで写せるか
- 各 OS の値で、実機を待っている物: O_SHLOCK / O_EXLOCK の定数 (FreeBSD・NetBSD・OpenBSD の fcntl.h で同じ値と確かめ済み)、bind が symlink を辿るかの表、標準に渡す長さ

## 決めること

- 足す OS と runtime の組
- 足せない OS は README の OS × 経路の表に「未検証」と書くか
