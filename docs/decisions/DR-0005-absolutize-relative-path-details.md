# DR-0005: 相対パスを絶対パスにする (ハブの DR-0019) の、TypeScript での細部

- Status: Active
- Date: 2026-11-22

## Context

- ハブの [DR-0019](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0019-absolutize-relative-path-on-bind.md) と SPEC「相対パスを絶対パスにする」で、bind 系 (`bind`・`bindEx`・`/bun` の `listen`・`listenEx`) と resolve は、相対パスを絶対パスの候補 (実パスと `$PWD` の候補) にしてから扱う。connect 系は変えない
- SPEC が言語に任せる所と、Node と Bun に固有の出方がある。実測 (macOS の Node 26.13.1 と Bun 1.4.4、Linux の docker の Node 26 と Bun 1.4.4 の Debian・alpine。2026-11-22)

| 操作 (cwd が PATH_MAX より深い時) | Node (macOS) | Bun (macOS) | Node (Linux glibc) | Bun (Linux) |
|---|---|---|---|---|
| `fs.realpathSync.native(".")` | `ERANGE` | `ENAMETOOLONG` | 成功 (PATH_MAX を超える実パス) | `ENAMETOOLONG` |
| その実パスの `stat` | | | `ENAMETOOLONG` | |
| `process.cwd()` | `ERANGE` | `ERANGE` | `ERANGE` | `ERANGE` (alpine は `ENAMETOOLONG`) |
| `fs.statSync(".")` | 成功 | 成功 | 成功 | 成功 |
| `stat($PWD)` | `ENAMETOOLONG` | `ENAMETOOLONG` | `ENAMETOOLONG` | `ENAMETOOLONG` (Debian。alpine の busybox は深い所で `pwd -L` が空で、測れていない) |

- `process.chdir` は、Node も Bun も `process.env.PWD` を直さない (macOS で実測)

## Decision

### `$PWD` の読み方

- `$PWD` は呼び出しごとに `Config.getenv("PWD")` で読む (既定は `process.env.PWD`)。試験は world の `getenv` で差し替える
- `process.chdir` の後に直されていない `$PWD` は、SPEC-routes のとおり `stat($PWD)` と `stat(".")` の `(st_dev, st_ino)` の比べで外す

### 実パスを長さのせいで使えない時

- 相対パスで、ソケットのディレクトリの realpath が `ENAMETOOLONG` か `ERANGE` の時に加え、realpath が返した実パスを確かめる `stat` が同じ理由で失敗した時 (Linux の glibc は PATH_MAX を超える実パスを返す) も、「パスの長さのせいで realpath を引けない」として SPEC の手順 5 に進む (経路を 1 つも試さず、`skipped` は空)
  - 経路は実パスを通る (link-dir の E が指す先、確かめの `stat`) ので、その実パスでは経路が使えない。経路に進んでも、E を作れずに使えないだけになる
- 絶対パスで同じことが起きた時は `ENAMETOOLONG` を返す (`ERANGE` を利用者に見せない)
- connect 系は変えない (今まで通り、realpath のエラーをそのまま返す)

### `..` を字句で畳む所

- `$PWD` の候補だけが `..` を字句で畳む。`path.resolve`・`path.join` を使わず、`foldLexically` (`src/paths.ts`) に書き出す。畳む所を確かめ (`(st_dev, st_ino)`) と一緒の 1 か所にするため。実パスの候補は `fs.realpathSync.native` (realpath(3)) に引かせる (JS 版の `fs.realpathSync` は `path.resolve` で先に畳む。実測)

### アドレスを返す口

- DR-0002「アドレスを返す口」のとおり、`address()` と `unix` は、絶対パスを渡された時はそのパス、相対パスを渡された時は絶対にした形を返す
- 経路に進んだ相対パスは、実パスの候補の形 (ソケットのディレクトリの realpath とファイル名) を返す。TS では経路に進むのは実パスを引けた時だけなので、`$PWD` の候補の形を返す場面は無い

### `ForConnect` の `spelling`

- 型は `ForBind` と同じ `Spelling`。値は `Original`・`CwdRelative`・`Linked` のどれか (SPEC)

### 数値に読める文字列の `./` と DR-0004

- node:net に `./` を付けて渡すのは、相対のまま渡す綴りだけになった (connect 系、bind と resolve の手順 5、名前で終わらない相対パス)。絶対パスの候補は `/` を含むので要らない
- DR-0004 の cwd の比べは `CwdRelative` の綴りだけ。絶対の綴り (短い絶対パス、候補) の置き換えの確かめは今まで通り

## Alternatives Considered

- 案 A: Linux の glibc が返す長い実パスは、そのまま経路に進ませる (経路が E を作れずに使えなくなってから手順 5)
  - 不採用理由: 結果は同じ (手順 5) で、`skipped` に経路の名前が入るだけ。OS で診断が分かれる。実パスを確かめる `stat` が長さで失敗する所で止めれば、macOS と同じ形 (`skipped` が空) になる
- 案 B: `$PWD` を `process.env.PWD` から直に読む (connect の relative の経路は今そうしている)
  - 不採用理由: 試験が子プロセスの環境変数を組み立てないと候補を強制できない。world の `getenv` を通せば、他の環境の読み方と同じに差し替えられる

## Consequences

- cwd が PATH_MAX より深い所では、短い相対パスの既定の `bind` は相対のまま標準に渡って通る。`bindEx` は、ソケットのファイルの realpath を引けず覚えられないので、SPEC「remove」のとおりエラーになる (DR-0004 で listener は閉じずに手放す)
- connect の relative の経路は、`$PWD` を `process.env` から読む (DR-0019 は connect 系を変えないので、そのままにした)。読み方をそろえるなら別の変更で

## 関連

- ハブの [DR-0019](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0019-absolutize-relative-path-on-bind.md)、[SPEC「相対パスを絶対パスにする」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md#相対パスを絶対パスにする)、[SPEC-routes「絶対パスの候補の作り方」](https://github.com/kawaz/sockat/blob/main/docs/SPEC-routes-ja.md#絶対パスの候補の作り方)
- [DR-0002](DR-0002-native-free-routes.md) (アドレスを返す口)、[DR-0004](DR-0004-close-relative-listener-only-when-ours.md)
