# MBook 内置音乐来源

这些是已有作者发布的 CC0 音乐节选，不是合成占位文件。授权页于 2026-10-14 核对。

- Juhani Junkala / SubspaceAudio：[JRPG Pack 4 Calm](https://opengameart.org/content/jrpg-pack-4-calm)，页面许可 CC0。
- Alexander Ehlers / tricksntraps：[Free Music Pack](https://opengameart.org/content/free-music-pack)，页面许可 CC0，作者声明这些是自己的作品，可用于任意用途，无须署名。
- [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)。

| ID | 原曲 | 作者 |
|---|---|---|
| cc01 | Peaceful Days | Juhani Junkala |
| cc02 | Childhood Friends | Juhani Junkala |
| cc03 | Summer Memories | Juhani Junkala |
| cc04 | Doomed | Alexander Ehlers |
| cc05 | A Place I Call Home | Juhani Junkala |
| cc06 | Spacetime | Alexander Ehlers |
| cc07 | Great mission | Alexander Ehlers |
| cc08 | Twists | Alexander Ehlers |
| cc09 | Sand Castles | Juhani Junkala |
| cc10 | Innocence | Juhani Junkala |

每首处理为 72 秒、32kHz 单声道 AAC 96kbps。原曲不足 72 秒时进行带过渡的循环拼接；其余截取前 72 秒。统一峰值、首尾淡变。详细原曲时长、修改说明及源文件/成品 SHA-256 见同目录 `credits.json`。

中文标题是 MBook 内部的场景别名；情绪三维是用于启动推荐的初始配置，并非作者标注。BPM 来自首 30 秒能量包络估计，置信不足保留 0，界面显示未确定；不声称是专业乐谱分析结果。实际听感与场景匹配仍需用户体验验收。

可复现脚本：项目 `scripts/fetch-cc0.py`、`scripts/prepare-cc0.py`、`scripts/cc0-metadata.mjs`。原始授权素材仅在开发缓存 `.artifacts/audio`；发布包仅含上述节选与许可记录。
