# Decision Records 一覧

Status は各 DR ファイルの `Status:` 行が正本。状態は絵文字とラベルだけ。

- `💭 提案`: Decision がまだ裁定されていない。実装に着手しない
- `✅ 実装済`: Decision の全部に実装エビデンスがある
- `🟡 部分実装`: 一部のみ実装
- `⬜ 未実装`: 裁定済みで設計のみ (着手してよい)
- `🚧 進行中`: 実装の途中
- `N/A`: 実装対象でない
- `❌ 撤退`: 撤退判断済

| DR | 状態 | 説明 |
|---|---|---|
| [DR-0001](DR-0001-public-api-shape.md) | ✅ 実装済 | 公開 API は node:net の型を返す Promise の関数を主にし、Bun の `Bun.listen` / `Bun.connect` の形は `@kawaz/sockat/bun` に置く |
| [DR-0002](DR-0002-native-free-routes.md) | ✅ 実装済 | native の部品を持たず JS だけで作れる経路だけを作る。D のロックは O_SHLOCK (BSD 系) と flock(1) に fd を継がせる形 (Linux)。listener は閉じると綴りで消す |
| [DR-0003](DR-0003-standard-length-per-runtime.md) | ✅ 実装済 | 標準に渡す長さは、runtime の標準が綴りを変えずに広げない sockaddr へ入れる最長 (Linux は Node 108・Bun 107、他は `sun_path` − 1) |

言語によらない振る舞いの正本は [ハブの SPEC](https://github.com/kawaz/sockat/blob/main/docs/SPEC-ja.md)。
