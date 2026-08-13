# Render

## Presets

```bash
openreelio-cli render presets
```

| ID               | Label                                | Container |
| ---------------- | ------------------------------------ | --------- |
| `mp4_h264_1080p` | MP4 H.264 1080p (default)            | mp4       |
| `mp4_h264_4k`    | MP4 H.264 4K                         | mp4       |
| `mp4_h265_1080p` | MP4 H.265 1080p                      | mp4       |
| `mp4_draft`      | MP4 H.264 720p Draft                 | mp4       |
| `proxy_480p`     | Proxy 480p (fast, agent inspection)  | mp4       |
| `webm_vp9_1080p` | WebM VP9 1080p                       | webm      |
| `prores_422`     | ProRes 422                           | mov       |

## Start a render

```bash
openreelio-cli render start --path ./demo --output out.mp4 \
  [--preset mp4_h264_1080p | --proxy] [--sequence <SEQ_ID>] \
  [--start 0] [--end 30] [--progress]
```

`--output` is required. `--preset` and `--proxy` conflict.

**`--proxy` is the inspection render.** It is an alias for the `proxy_480p`
preset: 854x480, CRF 30, H.264 + AAC, `ultrafast`. Use it whenever you are
checking your own work rather than delivering.

**`--start` / `--end`** limit the rendered range to timeline seconds. Combine
with `--proxy` to review just the section you changed. Note that a partial render
starts its own timebase at the range start, so `verify --file` on it will not
line up with timeline timecodes — pass a full-sequence render to `verify`.

**`--progress`** streams NDJSON to stderr:

```json
{"type":"progress","percent":42.0,"frame":151,"totalFrames":360,"fps":98.2,"etaSeconds":2,"message":"Encoding frame 151"}
```

The result on stdout:

```json
{"status":"ok","sequenceId":"…","preset":"proxy_480p","outputPath":"…",
 "durationSec":12.0,"fileSize":408445,"encodingTimeSec":0.27,
 "planHash":"c2b33fc72122ba67","warnings":[]}
```

## Inspect without encoding

```bash
openreelio-cli render graph --path ./demo [--sequence <SEQ_ID>]
```

Prints the renderer-agnostic graph so you can see what would be rendered — no
FFmpeg process, no output file.

## Cost discipline

Do not full-render to check an edit. In order of cost:

1. `frame extract --time` / `--grid` — stills, near-instant, no encode.
2. `render start --proxy --start A --end B` — 480p draft of just the range.
3. `render start --proxy` — 480p draft of the whole sequence, and what
   `verify --file` wants.
4. `render start --preset <delivery>` — only when you are actually delivering.

Renders honour Ctrl-C: the CLI wires the interrupt to the export engine's cancel
path rather than leaving an orphaned FFmpeg process.
