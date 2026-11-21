# DR-0003: 標準に渡す長さは、runtime の標準が綴りを変えずに広げない sockaddr へ入れる最長で、sockaddr に入る長さを超えない

- Status: Active (ハブの答え 2026-11-21。Linux の Node を 107 にそろえるのは、外部レビューの 3-1 を受けたハブの決定 2026-11-22: 標準に渡す長さは sockaddr に入る長さを超えない)
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

| runtime | Linux・illumos | macOS・FreeBSD・NetBSD・OpenBSD |
|---|---|---|
| Node | 107 | 103 |
| Bun (node:net を使う時も) | 107 | 103 |

- どの runtime も `sun_path` − 1 (SPEC の「sockaddr に入る長さ」) で、それを超えない。Linux の Node の標準は NUL の入らない 108 バイトもそのまま受け付けるが、そこへは渡さない
- 経路の綴りの上限も同じ長さ
- これを超えるパスは sockat の経路に回す。標準の迂回・広げた sockaddr・切り詰め・NUL の入らないアドレスには渡らない

## Alternatives Considered

- 案 A: 標準が通す長さまで標準に渡す
  - 不採用理由: Bun の迂回と Node の macOS の広げた sockaddr の bind は、別の言語の相手や運用の道具に、後で無関係なファイルに当たる綴りや途中で切れた綴りを見せる。境界が libuv の版とファイル名の長さで動き、長いパスでディレクトリが無い時に `ENOENT` を先に返す SPEC の約束も守れない (Bun は `EINVAL` を返す)
- 案 B: Linux の Node だけ 108 (NUL の入らない `sun_path` ちょうど) まで標準に渡す
  - 不採用理由: NUL の入らないアドレスは、他の言語の相手の `getpeername` / `recvfrom` で読めるかが確かめられていない。ハブの SPEC は標準に渡す長さを sockaddr に入る長さ以下と置いていて、108 を許すと適合試験で ts-node だけが `standard` になり、他の言語と比べられない (外部レビュー 3-1)

## Consequences

- Node 22 の Linux の切り詰めに sockat から渡ることは無い (107 を超えると経路に回り、届かなければ `ENAMETOOLONG`)
- Node と Bun で境界が同じになり、runtime を見分ける要が無くなった。境界は標準自身で試験する (ハブの DR-0004 の Consequences)
- 108 バイトちょうどのパスは、Linux の Node でも経路を通る (標準が受け付ける長さより 1 バイト短い所で経路に回る)

## 関連

- [DR-0001](DR-0001-public-api-shape.md)、[DR-0002](DR-0002-native-free-routes.md)
