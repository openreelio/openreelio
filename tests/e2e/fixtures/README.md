# E2E Test Fixtures

This directory contains test media files for end-to-end testing.

## Required Files

### sample-video.mp4
- Duration: 5 seconds
- Resolution: 1920x1080 (1080p)
- Codec: H.264
- Audio: AAC stereo
- Content: Any simple video (color bars, countdown, etc.)

### sample-audio.mp3
- Duration: 5 seconds
- Sample Rate: 44100 Hz
- Channels: Stereo
- Content: Any simple audio (tone, music clip, etc.)

## Generating Test Files

You can generate test files using FFmpeg:

```bash
# Generate 5-second test video with audio
ffmpeg -f lavfi -i testsrc=duration=5:size=1920x1080:rate=30 \
       -f lavfi -i sine=frequency=440:duration=5 \
       -c:v libx264 -preset fast -crf 23 \
       -c:a aac -b:a 128k \
       -y sample-video.mp4

# Generate 5-second test audio
ffmpeg -f lavfi -i sine=frequency=440:duration=5 \
       -c:a libmp3lame -b:a 128k \
       -y sample-audio.mp3
```

## Notes

- Test files are not committed to the repository due to size
- CI/CD pipeline should generate these files before running E2E tests
- Tests will skip gracefully if fixtures are missing
