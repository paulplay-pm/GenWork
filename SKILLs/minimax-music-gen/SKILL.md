---
name: minimax-music-gen
description: >
  Use when user wants to generate music, songs, or audio tracks. Triggers on phrases like
  "generate a song", "make music", "create a track", "写首歌", "生成音乐", "来一首歌",
  "帮我做首歌", "纯音乐", "cover", "唱一首", or any request involving music creation,
  song writing, lyrics generation, or audio production. Also triggers when user provides
  lyrics and wants them turned into a song, or describes a mood/scene and wants background
  music. Even casual requests like "给我来点音乐" or "I want a chill beat" should trigger
  this skill. Do NOT use for music playback of existing files, music theory questions, or
  music recommendation without generation.
license: MIT
metadata:
  version: "1.0"
  category: creative
---

# MiniMax Music Generation Skill

Generate songs (vocal or instrumental) using the MiniMax Music API. Supports two creation
modes: **Basic** (one-sentence-in, song-out) and **Advanced Control** (edit lyrics, refine
prompt, plan before generating).

## Prerequisites

- **mmx CLI** (required): Music generation uses the `mmx` command-line tool.

  **Check if installed:**
  ```bash
  command -v mmx && mmx --version || echo "❌ mmx not found"
  ```

  **Install (requires Node.js):**
  ```bash
  npm install -g mmx-cli
  ```

  **Authenticate (first time only):**
  ```bash
  mmx auth login --api-key <your-minimax-api-key>
  ```
  The API key can be obtained from [MiniMax Platform](https://platform.minimaxi.com/).
  Credentials are saved to `~/.mmx/credentials.json` and persist across sessions.

  **Verify:**
  ```bash
  mmx quota show
  ```

- Python 3.8+ (playback scripts use only stdlib).
- `ffplay` or `mpv` or `afplay` (macOS) for local playback. The script auto-detects.

## CLI Tool

This skill uses the `mmx` CLI for all music generation:

- **Music Generation**: `mmx music generate` — model: `music-2.6-free`
  - Supports `--lyrics-optimizer` to auto-generate lyrics from prompt
  - Supports `--instrumental` for instrumental tracks
  - Supports `--lyrics` for user-provided lyrics
  - Structured params: `--genre`, `--mood`, `--vocals`, `--instruments`, `--bpm`, `--key`, `--tempo`, `--structure`, `--references`
  
- **Cover**: `mmx music cover` — model: `music-cover-free`
  - Takes reference audio via `--audio-file <path>` or `--audio <url>`
  - `--prompt` describes the target cover style

**Agent flags**: Always add `--quiet --non-interactive` when calling mmx from scripts/agents.

**Pipeline**:
- Vocal: `User description → mmx music generate --lyrics-optimizer → MP3`
- Instrumental: `User description → mmx music generate --instrumental → MP3`
- Cover: `Source audio + style → mmx music cover → MP3`

## Storage

All generated music is saved to `~/Music/minimax-gen/`. Create the directory if it doesn't
exist. Files are named with a timestamp and a short slug derived from the prompt:
`YYYYMMDD_HHMMSS_<slug>.mp3`

---

## Workflow

## Language Detection

Detect the user's language from their message at the start of the session:
- Chinese (中文) → Set `LANG=zh` — all interactions in Chinese, generate Chinese lyrics
- English → Set `LANG=en` — all interactions in English, generate English lyrics

**IMPORTANT — Lyrics language rule**:
- Default lyrics language = user's language. 用户说中文 → 生成中文歌词。User speaks English → English lyrics.
- Only generate a different language if the user **explicitly** asks (e.g., "给我写首英文歌", "write Chinese lyrics").

Pass `--lang $LANG` to playback script invocations throughout the workflow.
Respond to the user in their detected language. Use the matching template below.

### Step 0: Detect Language & Intent

Detect the user's language and respond in the same language throughout. Parse their message
to determine:

1. **Song category**: vocal (人声音乐), instrumental (纯音乐), or cover
2. **Creation mode preference**: did they provide detailed requirements (→ Advanced) or a
   casual one-liner (→ Basic)?

If ambiguous, ask using this decision tree:

**If LANG=zh:**
```
Q1: 你想要哪种类型？
  - 🎤 人声音乐（有歌词演唱）
  - 🎵 纯音乐（无人声）
  - 🎧 Cover（翻唱风格）

Q2: 创作模式？
  - ⚡ 基础版 — 一句话描述，自动搞定
  - 🎛️ 强控制版 — 自己调歌词、prompt、风格
```

**If LANG=en:**
```
Q1: What type of music?
  - 🎤 Vocal (with lyrics)
  - 🎵 Instrumental (no vocals)
  - 🎧 Cover

Q2: Creation mode?
  - ⚡ Basic — one-line description, auto-generate
  - 🎛️ Advanced — edit lyrics, refine prompt, plan
```

If the user gives a clear one-liner like "帮我生成一首悲伤的钢琴曲", skip the questions —
infer instrumental + basic mode and proceed.

---

### Step 1: Basic Mode

**Goal**: User provides a short description → skill auto-generates everything → call API.

1. **Expand the description into a prompt**: Take the user's one-liner and expand it into a
   rich music prompt. Read `references/prompt_guide.md` for the style vocabulary and
   prompt structure. **The API prompt should always be written in English** for best
   generation quality, regardless of the user's language.
   
   Follow this pattern:
   ```
   A [mood] [BPM optional] [genre] song, featuring [vocal description],
   about [narrative/theme], [atmosphere], [key instruments and production].
   ```

2. **Show the user a preview** before generating:

   **If LANG=zh** — translate the prompt into Chinese for display, note the API uses English:
   ```
   🎵 即将为你生成：
   类型：人声音乐 / 纯音乐
   Prompt：一首忧郁内省的独立民谣，温柔女声，原声吉他，深夜独处的氛围
   （API 将使用英文 prompt 以获得最佳效果）
   歌词：自动生成
   
   确认生成？(直接回车确认，或告诉我要改什么)
   ```

   **If LANG=en:**
   ```
   🎵 About to generate:
   Type: Vocal / Instrumental
   Prompt: indie folk, melancholy, acoustic guitar, gentle female voice
   Lyrics: Auto-generated (--lyrics-optimizer)
   
   Confirm? (press enter to confirm, or tell me what to change)
   ```

3. **Call mmx**: Generate the music directly.

---

### Step 2: Advanced Control Mode

**Goal**: User has full control over every parameter before generation.

1. **Lyrics phase**:
   - If user provided lyrics: display them formatted with section markers, ask for edits.
     The final lyrics will be passed via `--lyrics` to mmx.
   - If user has a theme but no lyrics: will use `--lyrics-optimizer` to auto-generate.
   - Support iterative editing: "第二段副歌改一下" → only rewrite that section.
   - User can also write lyrics themselves and pass via `--lyrics`.

2. **Prompt phase**:
   - Generate a recommended prompt based on the lyrics' mood and content.
   - Present it as editable tags the user can add/remove/modify.
   - Read `references/prompt_guide.md` for the full vocabulary.

3. **Advanced planning** (optional, offer but don't force):
   - Song structure: verse-chorus-verse-chorus-bridge-chorus or custom
   - BPM suggestion (encode in prompt as tempo descriptor)
   - Reference style: "类似某种风格" → map to prompt tags
   - Vocal character description

4. **Final confirmation**: Show complete parameter summary, then generate.

---

### Step 3: Call mmx

Generate music using the mmx CLI:

**Vocal with auto-generated lyrics:**
```bash
mmx music generate \
  --prompt "<prompt>" \
  --lyrics-optimizer \
  --genre "<genre>" --mood "<mood>" --vocals "<vocal style>" \
  --instruments "<instruments>" --bpm <bpm> \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

**Vocal with user-provided lyrics:**
```bash
mmx music generate \
  --prompt "<prompt>" \
  --lyrics "<lyrics with section markers>" \
  --genre "<genre>" --mood "<mood>" --vocals "<vocal style>" \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

**Instrumental (no vocal):**
```bash
mmx music generate \
  --prompt "<prompt>" \
  --instrumental \
  --genre "<genre>" --mood "<mood>" --instruments "<instruments>" \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

Use structured flags (`--genre`, `--mood`, `--vocals`, `--instruments`, `--bpm`, `--key`,
`--tempo`, `--structure`, `--references`, `--avoid`, `--use-case`) to give the API
fine-grained control instead of cramming everything into `--prompt`.

Display a progress indicator while waiting. Typical generation takes 30-120 seconds.

---

### Step 4: Playback

After generation, play the song (prefer CLI players):

```bash
# macOS
afplay ~/Music/minimax-gen/<filename>.mp3

# Or with mpv/ffplay
mpv ~/Music/minimax-gen/<filename>.mp3
ffplay ~/Music/minimax-gen/<filename>.mp3
```

**Fallback (auto-detect player):**
```bash
python3 ~/.claude/skills/minimax-music-gen/scripts/play_music.py \
  --lang $LANG \
  ~/Music/minimax-gen/<filename>.mp3
```

Tell the user:

**If LANG=zh:**
```
🎵 正在播放：<filename>.mp3
📁 文件已保存到：~/Music/minimax-gen/<filename>.mp3
⏸️  按 q 或 Ctrl+C 可暂停/停止播放
```

**If LANG=en:**
```
🎵 Now playing: <filename>.mp3
📁 Saved to: ~/Music/minimax-gen/<filename>.mp3
⏸️  Press q or Ctrl+C to pause/stop playback
```

---

### Step 5: Feedback & Iteration

After playback, ask for feedback:

**If LANG=zh:**
```
这首歌怎么样？
  1. 🎉 很满意，保留！
  2. 🔄 不太行，调整后重新生成
  3. 🎨 歌词/风格微调后重新生成
  4. 🗑️ 不要了，删掉重来
```

**If LANG=en:**
```
How was this song?
  1. 🎉 Love it, keep it!
  2. 🔄 Not quite, adjust and regenerate
  3. 🎨 Fine-tune lyrics/style then regenerate
  4. 🗑️ Don't want it, start over
```

Based on feedback:
- **Satisfied**: Done. Mention the file path again.
- **Adjust & regenerate**: Ask what to change (prompt? lyrics? style?), apply edits,
  re-run generation. Keep the old file with a `_v1` suffix for comparison.
- **Fine-tune**: Enter Advanced Control Mode with the current parameters pre-filled.
- **Delete & restart**: Remove the file, go back to Step 0.

---

## Error Handling

| Error | Action |
|-------|--------|
| mmx not found | `npm install -g mmx-cli` |
| mmx auth error (exit code 3) | `mmx auth login` |
| Quota exceeded (exit code 4) | Report quota limit, suggest waiting or upgrading |
| API timeout (exit code 5) | Retry once, then report failure |
| Content filter (exit code 10) | Adjust prompt to avoid filtered content |
| Invalid lyrics format | Auto-fix section markers, warn user |
| No audio player found | Save file and tell user the path, suggest installing mpv |
| Network error | Show error detail, suggest checking connection |

---

## Cover Mode

Generate a cover version of a song based on reference audio. Model: `music-cover-free`.

**Reference audio requirements**: mp3, wav, flac — duration 6s to 6min, max 50MB.
If no lyrics are provided, the original lyrics are extracted via ASR automatically.

### Workflow

When the user selects Cover mode:
1. Ask for the source audio — a local file path or URL
2. Ask for the target cover style (e.g., "acoustic cover, stripped-down, intimate vocal")
3. Optionally ask for custom lyrics or lyrics file

### Commands

**Cover from local file:**
```bash
mmx music cover \
  --prompt "<cover style description>" \
  --audio-file <source.mp3> \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

**Cover from URL:**
```bash
mmx music cover \
  --prompt "<cover style description>" \
  --audio <source_url> \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

**With custom lyrics (text):**
```bash
mmx music cover \
  --prompt "<style>" \
  --audio-file <source.mp3> \
  --lyrics "<custom lyrics>" \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

**With custom lyrics (file):**
```bash
mmx music cover \
  --prompt "<style>" \
  --audio-file <source.mp3> \
  --lyrics-file <lyrics.txt> \
  --out ~/Music/minimax-gen/<filename>.mp3 \
  --quiet --non-interactive
```

### Optional flags

| Flag | Description |
|------|-------------|
| `--seed <number>` | Random seed 0–1000000 for reproducible results |
| `--channel <n>` | `1` (mono) or `2` (stereo, default) |
| `--format <fmt>` | `mp3` (default), `wav`, `pcm` |
| `--sample-rate <hz>` | Sample rate (default: 44100) |
| `--bitrate <bps>` | Bitrate (default: 256000) |

### After generation
Proceed with normal playback and feedback flow (Step 4 & 5).

---

## Important Notes

- **Never reproduce copyrighted lyrics.** When doing covers, always write original lyrics
  inspired by the song's theme. Explain this to the user.
- **Prompt language**: The API prompt works best with Chinese tags or English tags. Mix is OK.
- **Section markers in lyrics**: The API recognizes `[verse]`, `[chorus]`, `[bridge]`,
  `[outro]`, `[intro]`. Always include them when providing `--lyrics`.
- **File management**: If `~/Music/minimax-gen/` has more than 50 files, suggest cleanup
  when starting a new session.
- **Structured params**: Prefer using `--genre`, `--mood`, `--vocals`, `--instruments`,
  `--bpm` etc. over embedding everything in `--prompt`. This gives the API better control.