# webgpu-clip-recorder

Records real-time gameplay clips of WebGPU browser games on GitHub-hosted `macos-latest`
(Apple Paravirtual Metal GPU) with Playwright Chromium (`--enable-gpu --ignore-gpu-blocklist
--enable-unsafe-webgpu --use-angle=metal`) and Playwright `recordVideo` (page only, no desktop/popups).

Output per game: `<slug>.mp4` (H.264, 1280x720, 30 fps, real time), `<slug>.jpg` poster, `<slug>.json`
(adapter info, in-page rAF fps, WebGPU submits/s, video stats, rendered/blank verdict). The `all-clips`
artifact bundles everything plus a merged `report.json`.

```sh
gh workflow run record-webgpu-clips -R duestmanq/webgpu-clip-recorder \
  -f games="https://towersofaurum.com/ breakable-js nfsu2-web" -f duration=30
```

`games` takes URLs or slugs from aigamedevs/Claude-vs-ChatGPT `data/grokgames.json`. Manual trigger only.
