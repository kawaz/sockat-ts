# sockat-ts リファレンス

> [English](./REFERENCE.md) | 日本語

言語によらない振る舞いの正本は [sockat の仕様](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md) で、sockat-ts はその TypeScript 実装 (package `@kawaz/sockat`、Node.js 22 以上と Bun、native の部品なし)。ここには TypeScript での名前と型の対応、TypeScript での形、sockat-ts に固有の点を置き、言語によらない説明は仕様の該当の節へリンクする。使い方は [利用マニュアル](MANUAL-ja.md)。

## 標準との対応

- 戻り値は標準の `net.Server` / `net.Socket` (node:net。Node と Bun) と、`Bun.UnixSocketListener` / `Bun.Socket` (`@kawaz/sockat/bun`。Bun 以外で呼ぶとすぐエラー)
- 標準に渡す長さは、Node も Bun も Linux と illumos は 107 バイト、他は 103 バイトまで (`sun_path` − 1。Linux の Node は NUL の入らない 108 バイトも受け付けるが、渡さない)。それ以下の絶対パスは標準にそのまま渡す
- 相対パスは、bind 系 (`bind`・`bindEx`・`listen`・`listenEx`) と resolve では絶対パスにしてから扱い、connect 系 (`connect`・`connectEx`) では相対のまま扱う。仕様の「[相対パスを絶対パスにする](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#相対パスを絶対パスにする)」と、下の「[相対パス](#相対パス)」
- 空のパスと、先頭以外に NUL を含むパスは `TypeError` (`code` は `ERR_INVALID_ARG_VALUE`)。Linux では先頭が NUL のパス (abstract) を標準にそのまま渡す
- node:net は数値に読める文字列 (`"0"`・`"8080"`・`"1e3"`・空白だけ 等) を TCP のポートとみなす。相対のまま標準に渡す綴り (connect 系と、bind と resolve でどの候補も経路も使えない時) がスラッシュを含まずそう読める時は、`./` を付けて渡す (同じファイル。`Spelling` は `CwdRelative` のまま、`address()` は渡したパス)。`./` を付けて標準に渡す長さを超える時は長いパスとして扱う。bind の `"0"` は絶対パスの候補で標準に渡るので (`Original`)、`./` は要らず、`address()` はその絶対パス
- OS のエラーは Node の形 (`code`・`errno`・`syscall`・`path`。`path` は渡したパス)
- 他のパッケージに依存しない
- 長いパスと相対パスの bind では、標準と違う点がある。仕様の「[長いパスで標準と違う点](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#長いパスで標準と違う点)」と、下の「[SPEC から外れる点](#spec-から外れる点)」

## 関数

| 関数 | 返す物 | SPEC の関数 |
|---|---|---|
| `bind(path)` | `Promise<net.Server>` (listening になってから) | `bind` |
| `connect(path)` | `Promise<net.Socket>` (connect が終わってから) | `connect` |
| `bindEx(path, options?)` | `Promise<Bound<net.Server>>` | `bind_ex` |
| `connectEx(path, options?)` | `Promise<Connected<net.Socket>>` | `connect_ex` |
| `listen(options)` (`/bun`) | `Bun.UnixSocketListener` (同期) | `bind` |
| `connect(options)` (`/bun`) | `Promise<Bun.Socket>` | `connect` |
| `listenEx(options, sockatOptions?)` (`/bun`) | `Bound<Bun.UnixSocketListener>` (同期) | `bind_ex` |
| `connectEx(options, sockatOptions?)` (`/bun`) | `Promise<Connected<Bun.Socket>>` | `connect_ex` |
| `resolveForBind(path, options?)` | `ForBind` (同期) | `resolve_for_bind` |
| `resolveForConnect(path, options?)` | `ForConnect` (同期) | `resolve_for_connect` |
| `sweep()` | 無し | `sweep` |
| `sweepBase(path)` | 無し | `sweep_base` |

- `/bun` の関数は `Bun.listen` / `Bun.connect` と同じ引数を取り、`unix` が長くてもよい
- `connect_nonblocking` と DGRAM・SEQPACKET は無い ([SPEC から外れる点](#spec-から外れる点))

## 型

| SPEC の型 | TypeScript の型 |
|---|---|
| `Bound` | `Bound<S>` (`socket`、`file`、`spelling`、`route`、`base`、`skipped`) |
| `Connected` | `Connected<S>` (`socket`、`route`、`skipped`) |
| `ForBind` | `ForBind` (`path`、`spelling`、`route`、`base`、`skipped`、`cleanup()`、`socketFile()`) |
| `ForConnect` | `ForConnect` (`path`、`spelling`、`route`、`skipped`、`cleanup()`) |
| `SocketFile` | `SocketFile` (`remove()`、`cleanup()`) |
| 診断 | `route` (文字列)、`base` (`proc`・`tmp`・`runtime`・`tmpdir`・`sockdir`・`given`、B を通らなければ `null`)、`skipped` (`Skip[]`) |
| `_ex` と resolve の失敗 | OS のエラー (`SystemError`) に `route` (実際に bind / connect して失敗した経路、無ければ `null`) と `skipped` が付く (`RouteDiagnostics`) |
| 引数の誤り | `TypeError` (`code` は `ERR_INVALID_ARG_VALUE`) |

診断の意味は仕様の「[診断](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#診断)」。どれも中身を約束しないので、分岐は `spelling` で書く。

## `Options`

| 項目 | 意味 |
|---|---|
| `usableCrossUid` | 別の uid の相手も辿れる綴りを求める (bind 系だけが見る)。sockat-ts は thread-cwd を作らないので、満たせなければ `ENAMETOOLONG` |
| `base` | B そのもののパス (アプリが管理する場所。例 `/tmp/app-1000/sockat`)。`sweepBase(base)` で死んだ D を片付ける |

意味とエラーは仕様の「[`Options`](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#options)」と「[エラー](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#エラー)」。

## 綴りの性質 (`Spelling`)

意味は仕様の「[綴りの性質](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#綴りの性質-spelling)」。TypeScript では `kind` で分ける判別共用体。

| `kind` | 綴り |
|---|---|
| `"Original"` | 絶対パス。渡した絶対パスそのもの (abstract の名前も) か、同じ所を指す絶対パス (相対パスを絶対にした候補、長い絶対パスの実パスの候補) |
| `"CwdRelative"` | 渡した相対パスそのもの (`./` を付けた物も)。どの候補も経路も使えず、相対のまま標準に渡した時と、resolve に名前で終わらない相対パスを渡した時だけ |
| `"Linked"` | 置き場の B・D・E を通り、元のパスと同じ所を指す |
| `"Dangling"` | どこにも届かない (sockat-ts では生まれない) |

- `"Linked"` の属性は `removable`・`until` (`"Process"` / `"Cleanup"`)・`usableCrossUid`・`usableWithPrivateTmp`
- `ForConnect` の `spelling` は `"Original"`・`"CwdRelative"`・`"Linked"` のどれか
- listener の `address()` (node:net) と `unix` (`Bun.listen`) は綴りでなく、絶対パスを渡した時はそのパス、相対パスを渡した時は絶対にした形を返す ([相対パス](#相対パス))

## 相対パス

bind 系と resolve は相対パスを絶対パスにしてから扱い、connect 系は相対のまま渡す。手順と標準と違う点は仕様の「[相対パスを絶対パスにする](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#相対パスを絶対パスにする)」。TypeScript では:

- 絶対パスの候補を標準に渡した時、`address()` と `unix` はその候補を返す
- 経路に進んだ時は、実パスの候補の形 (ソケットのディレクトリの実パスとファイル名) を返す
- どの経路も使えずに相対のまま標準に渡した時 (`CwdRelative`) だけ、渡した相対パスのまま返す
- `$PWD` は呼び出しのたびに環境変数から読む (`process.chdir` は `$PWD` を直さないので、cwd と違う `$PWD` は候補にしない)
- cwd が PATH_MAX より深いと (実パスを引けない)、短い相対パスの既定の `bind` は相対のまま標準に渡って通る。`bindEx` はソケットのファイルを覚えられずエラーになる
- 細部は [DR-0005](decisions/DR-0005-absolutize-relative-path-details.md)

## ソケットのファイルを消す (`file`)

`file.remove()` と `file.cleanup()` の約束は仕様の「[片付け](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#片付け)」。使い方は利用マニュアルの「[終わる時にソケットのファイルを消す](manual/bind-ja.md#終わる時にソケットのファイルを消す)」。

- `remove()` はファイルを消すだけで、listener を閉じない。listener を閉じる前に呼ぶ
- `bindEx` / `listenEx` の listener も、閉じると綴りを unlink する ([SPEC から外れる点](#spec-から外れる点))
- ファイルを覚えられない時、`bindEx` はエラーにする。経路の綴りは symlink を先に消してから listener を閉じる (置き換わった物は消さない)。標準に渡した綴り (短い絶対パス、絶対パスの候補、相対のまま渡した綴り) は、閉じると bind したソケットだけが消えると確かめられる時だけ閉じ、それ以外は閉じずに `unref()` して手放す ([SPEC から外れる点](#spec-から外れる点))

## resolve (`ForBind`・`ForConnect`)

返す綴りと使えない時は仕様の「[resolve](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#resolve)」と「[`ForBind` の `SocketFile`](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#forbind-の-socketfile)」。使い方は利用マニュアルの「[パスだけを解決する](manual/resolve-ja.md)」。

- 綴りは標準の口 (`net.Server.listen`、`net.connect`、`Bun.serve({ unix })`、`fetch(url, { unix })`、node:http の `socketPath` 等) に渡す。node:net には数値に読める綴りも `./` を付けて返す
- `ForBind.socketFile()` は listen の後・listener を閉じる前に呼ぶ
- 届かない長さは `ENAMETOOLONG`

## 置き場に残る物と `sweep`

何が残り、いつ消えるかは仕様の「[置き場に残る物](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#置き場に残る物)」と「[`sweep`](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#sweep)」。TypeScript での形:

- 既定の `bind` / `listen` は `file` を返さない。長いパスに何度も bind する長命のプロセスは `bindEx` / `listenEx` を使い、`file.remove()` か `file.cleanup()` で片付ける
- 試験を繰り返す環境では `sweep()` を、`options.base` の B は `sweepBase(base)` を呼ぶ。自動では呼ばれない

## 使ってはいけない書き方

一覧となぜいけないかは仕様の「[使ってはいけない書き方](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#使ってはいけない書き方)」。TypeScript での形と避け方 (下のコードは [test/manual.test.ts](../test/manual.test.ts) で動かしている):

| TypeScript での形 | 代わりに |
|---|---|
| `spelling` を見ずに、カーネルが返す綴り (他の言語の相手の `getpeername`、`lsof` の出力等) で `fs.unlinkSync` / `fs.statSync` する | 渡したパスを持っておいて使う。`b.file.remove()` |
| `cleanup()` の後やプロセスが終わった後に `f.path` を使う | 綴りは `until` の間だけ使う |
| 相対パスで bind し、`process.chdir` の後にその相対パスの文字列で `fs.unlinkSync` する | `b.file.remove()` |
| `spelling` が `CwdRelative` の listener を、`process.chdir` の後に閉じる (標準が閉じた時点の cwd で相対パスを unlink する) | cwd を変える前に `b.file.remove()` を呼んで閉じる |
| `server.close()` / `listener.stop()` でソケットのファイルが消えると当てにする (link-file の綴りでは symlink だけが消える) | `b.file.remove()` か、渡したパスで消す |
| `b.file.remove()` で listener も閉じると当てにする | listener は自分で閉じる |
| `server.close()` の後に `b.file.remove()` を呼ぶ | 閉じる前に呼ぶ |
| `/proc` を通る綴りや `usableCrossUid` が false の綴りを、別の uid の相手に辿らせる | `{ usableCrossUid: true }` を渡す (満たせなければ満たさない綴りに落とさず `ENAMETOOLONG`) |
| `route`・`base`・`skipped` の文字列で分岐する | `spelling` で分岐する |

```ts
// keep the path given, and remove before closing
const b = await bindEx(path);
try {
  // ...
} finally {
  b.file.remove();
  b.socket.close();
}
// ENAMETOOLONG where no spelling another uid can follow can be had
const f = resolveForBind(path, { usableCrossUid: true });
```

## 長いパスへの届き方

標準に渡す長さを超えるパスは、仕様の「[長いパスの経路と試す順番](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#長いパスの経路と試す順番)」の経路を順に試す。bind と resolve は、経路の前に絶対パスの候補 (相対パスは実パスと `$PWD` の候補、長い絶対パスは実パスの候補) が収まるかを見て、収まればそれを標準に渡す (置き場に何も作らない)。相対パスは、短くても絶対にすると長ければ経路に進む。

native の部品が要る経路は作らず、使えない経路として `skipped` に入れて次へ進む (理由は `no native code in sockat-ts`)。

| OS | bind | connect |
|---|---|---|
| Linux / Android | link-dir (`/proc` を通す綴り → B の実パス) → thread-cwd (作らない) | proc-direct (`/proc` が無ければ relative) → thread-cwd-direct (作らない) → link-file |
| macOS | link-dir → link-file → thread-cwd (作らない) | relative → widened (作らない) → thread-cwd-direct (作らない) → link-file |
| FreeBSD | link-dir → at (作らない) | at-direct (作らない) → link-file |
| NetBSD | link-dir → link-file | relative → link-file |
| OpenBSD・illumos | link-dir | relative → link-file |

- 経路の中身は仕様の「[経路の名前](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#経路の名前)」、B の作り方は [SPEC-routes](https://github.com/kawaz/sockat/blob/main/docs/SPEC-routes-ja.md)
- D のロック: macOS と BSD は `O_SHLOCK` で開く、Linux は `flock(1)` (util-linux / busybox) に fd を継がせる。**Linux で `flock(1)` が無いと、長いパスの bind と resolve は `ENAMETOOLONG`** (既定の connect は届く)。illumos はロックの手段が無く同じ

### どこから届かなくなるか

ディレクトリが標準に渡す長さを超えるほど深い時に、sockat-ts で届くファイル名の長さ (バイト。置き場は OS の既定)。作らない経路の分、ハブの [届く範囲](https://github.com/kawaz/sockat/blob/main/pages/reach/README-ja.md) の他の言語より短い所がある:

| OS | bind (`bind`・`bindEx`・`listen`・`resolveForBind`) | `connect`・`connectEx` | `resolveForConnect` |
|---|---|---|---|
| Linux / Android | およそ 76 (`/proc` を通す綴りはおよそ 70) | 255 まで | 255 まで |
| macOS | 255 まで (link-file) | 255 まで | 255 まで |
| FreeBSD・OpenBSD | およそ 72 | 255 まで | 255 まで |
| NetBSD | 255 まで (link-file) | 255 まで | 255 まで |
| illumos | 届かない (D をロックできない) | 255 まで (D を作らない) | 届かない (D をロックできない) |

B を作れない環境 (置き場が全部書けない等) では、B を通る経路が使えず、connect は proc-direct・relative の分だけ届く。

Linux で `/proc` が見えない環境 (空の tmpfs を被せた等) では、Bun 自体が起動時に `abort()` で落ちる (Bun 1.4.4・1.4.5 で確認。sockat を使わない `bun -e 'console.log(1)'` も同じ)。Node はそのまま動き、connect は relative を使う。

## SPEC から外れる点

- 作らない経路 ([長いパスへの届き方](#長いパスへの届き方) の表) でしか届かない所に届かない
- **`bindEx` / `listenEx` の listener も、閉じると綴りを unlink する** (SPEC は「`_ex` の listener は閉じても消さない」。runtime に止める口が無い)。`file.remove()` は閉じる前に呼ぶ
- `bindEx` / `listenEx` が標準に渡した綴りのファイルを覚えられなかった時 (bind の直後にソケットが置き換えられた、`CwdRelative` で bind の間に cwd が変わった、cwd が PATH_MAX より深い) は、閉じると bind したソケットだけが消えると確かめられる時にだけ閉じる。それ以外は listener を閉じずに `unref()` して手放す。置き換えた物と、bind したソケットのファイルは残る ([DR-0004](decisions/DR-0004-close-relative-listener-only-when-ours.md))。標準は閉じる時に渡した綴りを unlink する (相対の綴りは閉じた時点の cwd で) ので、SPEC の「閉じる」をそのまま当てると、それらを消してしまうため
- 相対のまま標準に渡した綴り (`CwdRelative`) の listener は、標準が閉じた時点の cwd で unlink する。cwd を変えた後に閉じると、移った先の同じ名前のファイルを消す
- DGRAM と SEQPACKET は無い (Node と Bun の標準に無い)
- 標準に渡した綴り (短い絶対パス、絶対パスの候補、相対のまま渡した綴り) のエラーは標準のまま (Node の listen は無いディレクトリに `EACCES` を返す)。短い相対パスでディレクトリが無い時は、候補を作れずに SPEC どおり `ENOENT` (`route` は `null`)。長いパスも SPEC の errno (`ENOENT`)

## 仕様と設計

- [sockat の仕様](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md) — 言語によらない振る舞い (公開する操作、resolve、綴りの性質、片付け、置き場に残る物、経路、標準と違う点、使ってはいけない書き方、エラー)
- [言語ごとの注意](https://github.com/kawaz/sockat/blob/main/pages/langs-ja.md) — 各言語の実装に固有の注意の一覧
- [docs/decisions/](decisions/INDEX.md) — TypeScript 版の設計の判断 (DR)
