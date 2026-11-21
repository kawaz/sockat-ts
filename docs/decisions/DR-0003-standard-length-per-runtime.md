# DR-0003: 標準に渡す長さは、runtime の標準が綴りを変えずに広げない sockaddr へ入れる最長

- Status: Active (ハブの答え 2026-11-21。ハブの DR-0004 と SPEC の用語も同じ意味に直った)
- Date: 2026-11-21

## Context

ハブの [DR-0004](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0004-standard-length-per-language.md) は、標準に渡す長さを「標準が、パスを変えずに広げない sockaddr に入れて受け付ける最長」とし、標準の切り詰め・広げた sockaddr・自前の迂回は使わない。Node と Bun の標準は、`sun_path` に入らないパスでも次のように受け付けることがある ([ハブの research](https://github.com/kawaz/sockat/blob/main/docs/research/2026-11-21-typescript-port.md) 1-1・1-2):

| runtime | OS | 普通の sockaddr にそのまま入れる最長 | それを超えた時 |
|---|---|---|---|
| Node 24 以上 | Linux | 108 (NUL なし) | `EINVAL` |
| Node 22 | Linux | 108 | 108 バイトに黙って切り詰めて成功する |
| Node (libuv 1.53 以上) | macOS | 103 | 253 まで広げた sockaddr で bind / connect する |
| Bun | Linux | 107 | ファイル名が収まれば `/proc/self/fd/<閉じた fd>/<ファイル名>` で bind / connect する |
| Bun | macOS | 103 | ファイル名が収まれば呼び出し元のスレッドの cwd を移し、ファイル名だけで bind / connect する |

Bun の迂回と広げた sockaddr の bind は、ハブの DR-0017 が bind に使わないと決めた綴り (後で無関係なファイルに当たる、読む側を壊す) を作る。Bun の境界はパスの長さでなくファイル名の長さで動く。

## Decision

標準に渡す長さ (bind と connect で同じ):

| runtime | Linux | Linux 以外 |
|---|---|---|
| Node | 108 | `sun_path` − 1 (macOS・FreeBSD・NetBSD・OpenBSD は 103、illumos は 107) |
| Bun (node:net を使う時も) | 107 | 同上 |

- runtime は `process.versions.bun` の有無で見分ける。libuv の版は見ない
- これを超えるパスは sockat の経路に回す。標準の迂回・広げた sockaddr・切り詰めには渡らない

## Alternatives Considered

- 案 A: 標準が通す長さまで標準に渡す
  - 不採用理由: Bun の迂回と Node の macOS の広げた sockaddr の bind は、別の言語の相手や運用の道具に、後で無関係なファイルに当たる綴りや途中で切れた綴りを見せる。境界が libuv の版とファイル名の長さで動き、長いパスでディレクトリが無い時に `ENOENT` を先に返す SPEC の約束も守れない (Bun は `EINVAL` を返す)
- 案 B: Node の Linux も 107 にそろえる
  - 不採用理由: 108 は Node の標準がカーネルにそのまま渡す長さで、綴りを変えない。標準が自分で正しく扱う範囲を sockat が横取りする理由が無い

## Consequences

- Node 22 の Linux の切り詰めに sockat から渡ることは無い (108 を超えると経路に回り、届かなければ `ENAMETOOLONG`)
- Node と Bun で Linux の境界が 1 バイト違う。境界は標準自身で試験する (ハブの DR-0004 の Consequences)

## 関連

- [DR-0001](DR-0001-public-api-shape.md)、[DR-0002](DR-0002-native-free-routes.md)
