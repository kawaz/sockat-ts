# AGENTS.md — sockat-ts の作業ルール

sockat-ts は、`sun_path` の上限を超えるパスでも Unix domain socket を bind / connect できる TypeScript のライブラリ (package `@kawaz/sockat`、Node 22 以上と Bun)。短いパスは標準 (node:net、`Bun.listen` / `Bun.connect`) にそのまま渡し、長いパスだけを OS ごとの経路で短い綴りにして渡す。

言語によらない振る舞いの正本はハブの [sockat の仕様](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md) (kawaz/sockat、手元は `../../sockat/main`) で、sockat-ts はその TypeScript 実装。Go 版 (`../../sockat-go/main`) が最も近い参考実装。

## 必読

- [docs/decisions/](docs/decisions/INDEX.md) — TypeScript 版の設計 (公開 API の形、native 抜きで作る経路とロック、標準に渡す長さ)
- ハブの [SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)・[SPEC-routes](https://github.com/kawaz/sockat/blob/main/docs/SPEC-routes-ja.md)・[DR-0017](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0017-resolve-through-persistent-base.md) — 置き場と経路の作り方の正本

## 構成

| パス | 中身 |
|---|---|
| `src/index.ts` | `@kawaz/sockat` の公開 API (`bind`・`connect`・`bindEx`・`connectEx`・`resolveForBind`・`resolveForConnect`・`sweep`・`sweepBase`) と型の再 export |
| `src/bun.ts` | `@kawaz/sockat/bun` の公開 API (`listen`・`connect`・`listenEx`・`connectEx`)。`Bun.listen` / `Bun.connect` に綴りを渡す |
| `src/netapi.ts` | node:net に綴りを渡す口 (`listenAt`・`connectAt`) と、world を引数に取る bind / connect の本体 (試験が world を差し替えて呼ぶ) |
| `src/bunapi.ts` | `Bun.listen` / `Bun.connect` に綴りを渡す口と、world を引数に取る listen / connect の本体 |
| `src/types.ts` | 公開の型 (`Options`・`Spelling`・`Bound`・`Connected`・`ForBind`・`ForConnect`・`SocketFile`) |
| `src/errors.ts` | エラーの形 (Node の流儀の OS のエラー、`ERR_INVALID_ARG_VALUE`、一般のエラー、診断の `route`・`skipped`)、`Trace`、`Unusable`、errno の読み取り |
| `src/config.ts` | 環境の読み方 (`Config`: OS、標準に渡す長さ、置き場の候補、`/proc`、bind が symlink を辿るか、乱数、ロックの手段) と `envConfig` |
| `src/world.ts` | `World` (プロセスが持つ B)、B の作り方・確かめ方、D の作り方とロック、resolve の E、`defaultWorld` / `setDefaultWorld` (試験用) |
| `src/route.ts` | 経路の前の検査 (`classify`: base の形・NUL・abstract・長さ)、ソケットのディレクトリを先に引く `lookUpDir`、経路の失敗のエラー |
| `src/bind.ts` | bind の列 (`bindSteps`: link-dir・link-file、作らない経路の skipped) と B を通る綴り (procB と実パス、長さの見積もり、`Spelling`) |
| `src/connect.ts` | connect の列 (`connectSteps`: proc-direct・relative・link-file、作らない経路の skipped) と相対パスの作り方 |
| `src/drive.ts` | 列 (generator) を標準に渡して回す `driveAsync` / `driveSync` と、`bindEx` の覚え方 (`beforeBind`・`boundOf`) |
| `src/resolve.ts` | `resolveForBind` / `resolveForConnect` の本体と `ForBind` の `socketFile` |
| `src/socketfile.ts` | E の片付け (`Cleaner`) と `SocketFile` (`remove`・`cleanup`) |
| `src/sweep.ts` | `sweep` / `sweepBase` の本体 (死んだ D を排他のロックで見分けて消す) |
| `src/lock.ts` | D のロック (`O_SHLOCK` / `O_EXLOCK`、`flock(1)` に fd を継がせる形) |
| `src/fsx.ts` | `(st_dev, st_ino)`、実パス、`socketAt`、`*at` の代わり (`/proc/self/fd/<fd>/<名前>` か確かめた実パス) |
| `src/paths.ts` / `src/names.ts` | パスの算術、乱数の名前と `createAt` |
| `conformance/cli.ts` | ハブの適合試験の CLI (`just conformance [node\|bun]`)。package に入らない |
| `test/*.test.ts` | 試験 (`node:test` で書き、Node と Bun の両方で走る)。`helpers.ts` が試験専用の置き場と world を用意し、`child.ts` が cwd を変える試験を子プロセスで走らせる |

## 試験

- `just test` で Node と Bun の両方 (macOS)、`just test-linux` で docker の Linux (Node 22・24・26、Bun の Debian と alpine)。経路は OS で違うので、変えたら両方で回す
- 試験は `node:test` と `node:assert/strict` で書く。Node は `node --test` が `.ts` の型を剥がして走らせ、Bun は `bun test` が同じ試験を走らせる
- 経路は world の `Config` (`proc`・`bindFollows`・`lock`・置き場) を差し替えて強制する。公開 API の試験も `helpers.ts` が `setDefaultWorld` で試験専用の置き場 (`/tmp/stt-*`、1777) に向ける
- 一時ディレクトリはランダム名で作り、プロセスの終わりに消す。名前の接頭辞は `stt-` で、`sockat` で始めない。長さを決めたいものは `/tmp` の下、他は `$TMPDIR` の下
- cwd のようにプロセス全体に効く設定を変える試験は子プロセス (`test/child.ts`) で行う
- 各試験の直前に「何を確かめ、なぜそうなるべきか」をコメントで書く

## 守ること

- **振る舞いを変える時は、先にハブの SPEC を直す。** SPEC と食い違う・決まらない所は自分で決めずハブの統括に聞く
- **標準に渡す長さ以下のパスには何も足さない** (DR-0003)
- **経路の本当の失敗は次の経路でやり直さない。** 次へ進むのは経路自体が使えない時だけ。失敗した時はその呼び出しで作った E を消してから返す
- **既定の connect は D を作らず、E を残さない**
- **経路は公開 API に出さない。** 試験はパッケージの中から環境の読み方を差し替えて各経路を強制する
- **試験は本物の `/tmp/sockat-<uid>` を使わない・消さない。** 試験の一時ディレクトリの名前を `sockat` で始めない (適合試験や他の道具が置き場の B とみなす)
- 型: 外から来るデータ (stdin の JSON 等) は受け取った境界でスキーマに通す。`as` (`as const` 以外)・`any`・非 null の `!` を使わない
- 公開 API・doc・エラーの文言は英語。DR と日本語の docs は日本語

## VCS と push

- jj colocate。commit は `jj commit -m "..." <files...>` でパスを指定する
- push は `just push` だけ
- README は日本語版 (`README-ja.md`) が正本。英語版は同じ変更で直す
- package.json の version を上げた push で、CI を通してから Release が registry に公開し、tag と GitHub Release を作る。version を上げるのは kawaz の OK を取ってから
