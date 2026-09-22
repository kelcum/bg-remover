# Background Remover

Removes the background from any image or animated GIF, entirely in your browser. No uploads — the neural network (ISNet, via ONNX/WebAssembly) runs on your own device.

**Live site:** https://kelcum.github.io/bg-remover/

- Static images → transparent PNG or GIF
- Animated GIFs → processed frame by frame, re-encoded as an animated GIF with the original timing preserved
- GIF transparency is all-or-nothing per pixel (the format has no soft alpha), so there's an edge-cutoff slider to tune the threshold

## Running locally

```
python serve.py
```

then open `http://localhost:8743`. A local server is required (rather than opening `index.html` directly) because the app uses ES module imports. `serve.py` also sets `Cross-Origin-Opener-Policy`/`Cross-Origin-Embedder-Policy` headers, which roughly halves processing time by enabling multi-threaded WASM. The deployed site gets the same benefit via `coi-serviceworker.js`, since GitHub Pages can't set custom headers.

## Notes

- First use downloads the removal model (~45–90 MB depending on the quality setting you pick); the browser caches it after that.
- Uses [`@imgly/background-removal`](https://github.com/imgly/background-removal-js), which is AGPL-licensed.
