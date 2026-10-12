# Ruby API・導入設定

このディレクトリは [bbb-recording-editor](https://github.com/hiroshisuga/bbb-recording-editor) のバックエンドです。

導入・更新・認証・再構築・編集履歴・初期化・アンインストール・開発とテストの手順は、[リポジトリのREADME](../README.md) にまとめています。

- `server.rb`: HTTP APIと編集画面の配信。
- `lib/recording_editor.rb`: raw録画の読み込み、保存、初期化、再構築の管理。
- `deploy/`: systemd・Nginx・認証・再構築ヘルパーとインストーラー。
- `test/`: Ruby・Pythonのテストとデモ録画の生成。
