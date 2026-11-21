# DR-0001: 公開 API は node:net の型を返す Promise の関数を主にし、Bun の形は `@kawaz/sockat/bun` に置く

- Status: Active
- Date: 2026-11-21

## Context

[ハブの SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md) の「公開する操作」は、関数 (bind / connect と各 `_ex`、resolve の 2 つ、`sweep` の 2 つ)、`Options`、返す物 (`Bound`・`Connected`・`ForBind`・`ForConnect`)、`Spelling`、片付けの `remove` / `cleanup` を決め、名前と形は各言語の慣習に任せる。

TypeScript の事情:

- 標準が 2 系統ある。node:net (`net.Server` / `net.Socket`。Node と Bun の両方で動く) と、Bun だけの `Bun.listen` / `Bun.connect`
- 依頼元の claude-ccmsg (Bun) は `Bun.listen({ unix })` と `Bun.connect({ unix })` を使っている
- 標準の listen と connect は結果をイベントで返す。sockat は経路を順に試し、実際に bind / connect して失敗したら次を試さない (SPEC)。結果を待たないと次へ進むかを決められない
- Node と Bun の標準に Unix の DGRAM と SEQPACKET は無い ([ハブの research](https://github.com/kawaz/sockat/blob/main/docs/research/2026-11-21-typescript-port.md) 1-5)

## Decision

`@kawaz/sockat` (node:net の型):

| 関数 | 戻り値 | SPEC |
|---|---|---|
| `bind(path)` | `Promise<net.Server>` (listening になってから resolve) | `bind` |
| `connect(path)` | `Promise<net.Socket>` (connect が終わってから resolve) | `connect` |
| `bindEx(path, options?)` | `Promise<Bound<net.Server>>` | `bind_ex` |
| `connectEx(path, options?)` | `Promise<Connected<net.Socket>>` | `connect_ex` |
| `resolveForBind(path, options?)` | `ForBind` | `resolve_for_bind` |
| `resolveForConnect(path, options?)` | `ForConnect` | `resolve_for_connect` |
| `sweep()` | `void` | `sweep` |
| `sweepBase(path)` | `void` | `sweep_base` |

`@kawaz/sockat/bun` (Bun だけ。引数は `Bun.listen` / `Bun.connect` と同じ options で、`unix` に長いパスを渡せる):

| 関数 | 戻り値 |
|---|---|
| `listen(options)` | `Bun.UnixSocketListener` (標準と同じく同期) |
| `connect(options)` | `Promise<Bun.Socket>` |
| `listenEx(options, sockatOptions?)` | `Bound<Bun.UnixSocketListener>` |
| `connectEx(options, sockatOptions?)` | `Promise<Connected<Bun.Socket>>` |

型:

| 型 | 中身 |
|---|---|
| `Options` | `usableCrossUid?: boolean`、`base?: string` |
| `Bound<S>` | `socket: S`、`file: SocketFile`、`spelling: Spelling`、`route: string`、`base: string \| null`、`skipped: Skip[]` |
| `Connected<S>` | `socket: S`、`route: string`、`skipped: Skip[]` |
| `Skip` | `name: string`、`reason: string` |
| `SocketFile` | `remove(): void`、`cleanup(): void` |
| `ForBind` | `path`、`spelling`、`route`、`base`、`skipped`、`cleanup(): void`、`socketFile(): SocketFile` |
| `ForConnect` | `path`、`route`、`skipped`、`cleanup(): void` |
| `Spelling` | `kind` で分ける union。`{ kind: "Original" }`・`{ kind: "CwdRelative" }`・`{ kind: "Linked", removable, until: "Process" \| "Cleanup", usableCrossUid, usableWithPrivateTmp }`・`{ kind: "Dangling" }` |

エラー:

- OS のエラーは Node の流儀の `Error` (`code` に errno の名前、`errno`、`syscall`、`path` は呼び出し元のパス)。経路の綴りはエラーに出さない
- `_ex` と resolve のエラーには `route` (実際に bind / connect して失敗した経路、無ければ `null`) と `skipped` を付ける
- 引数の誤り (SPEC「エラー」) は `TypeError` で `code` が `ERR_INVALID_ARG_VALUE`。一般のエラー (relative の途中で cwd が変わった) は `code` を持たない `Error`

- 名前は JS の慣習 (camelCase) にする。経路の名前と `Spelling` の値は SPEC と同じ ASCII
- connect は 1 つ (標準の connect が元から待たない言語。ハブの DR-0003)
- DGRAM・SEQPACKET は写さない (写す標準が無い)
- `resolveForBind`・`resolveForConnect`・`sweep`・`SocketFile` の method は同期 (fs の同期の操作で済む)。resolve の綴りは `Bun.serve({ unix })` や `fetch(url, { unix })` 等、sockat が包まない標準にも渡せる

## Alternatives Considered

- 案 A: `net.createServer` / `net.connect` と同じ形 (同期で返し、結果はイベント) にする
  - 不採用理由: 実際に試した経路の失敗を見てから次を決める作りと合わず、`_ex` の診断を返す口も無い。返す型は標準と同じなので、`await` を足すだけで置き換えられる
- 案 B: node:net の型だけを出す
  - 不採用理由: 依頼元が使う `Bun.listen` / `Bun.connect` から置き換えられない
- 案 C: SPEC の名前のまま snake_case (`bind_ex`)
  - 不採用理由: JS の慣習と違う

## Consequences

- `bind` は listening になるまで、`connect` は connect が終わるまで待つ。標準の `listen()` / `net.connect()` のようにその場で返らない
- Bun の利用者は 2 系統のどちらからでも置き換えられる

## 関連

- [DR-0002](DR-0002-native-free-routes.md)、[DR-0003](DR-0003-standard-length-per-runtime.md)
- ハブの [SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)、[DR-0003](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0003-single-connect-when-standard-never-blocks.md)
