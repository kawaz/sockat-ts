# AGENTS.md — sockat-ts の作業ルール

sockat-ts は、`sun_path` の上限を超えるパスでも Unix domain socket を bind / connect できる TypeScript のライブラリ (package `@kawaz/sockat`、Node 22 以上と Bun)。短いパスは標準 (node:net、`Bun.listen` / `Bun.connect`) にそのまま渡し、長いパスだけを OS ごとの経路で短い綴りにして渡す。

言語によらない振る舞いの正本はハブの [sockat の仕様](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md) (kawaz/sockat、手元は `../../sockat/main`) で、sockat-ts はその TypeScript 実装。Go 版 (`../../sockat-go/main`) が最も近い参考実装。

## 必読

- [docs/decisions/](docs/decisions/INDEX.md) — TypeScript 版の設計 (公開 API の形、native 抜きで作る経路とロック、標準に渡す長さ)
- ハブの [SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)・[SPEC-routes](https://github.com/kawaz/sockat/blob/main/docs/SPEC-routes-ja.md)・[DR-0017](https://github.com/kawaz/sockat/blob/main/docs/decisions/DR-0017-resolve-through-persistent-base.md) — 置き場と経路の作り方の正本

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
