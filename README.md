<p align="center"><img src="logo.svg" width="88" alt="Peel logo"></p>

<h1 align="center">Peel</h1>

<p align="center">Peel the background off any image or animated GIF, right in your browser.</p>

<p align="center"><b><a href="https://kelcum.github.io/bg-remover/">kelcum.github.io/bg-remover</a></b></p>

---

Peel removes image backgrounds with an AI model that runs entirely on your device. Images are never uploaded, there's no sign-up, and it's free.

- Drop in photos, product shots or logos (JPG, PNG, WEBP, iPhone HEIC) or animated GIFs; several at once is fine
- Drag the before/after slider to check the cutout
- Keep the background transparent, pick a color, or blur the original for a portrait-mode look
- Save as PNG, WEBP, JPG or GIF. Animated GIFs keep every frame and their timing.

## How it works

- The [IMG.LY background removal](https://github.com/imgly/background-removal-js) model runs through ONNX Runtime Web, on the GPU (WebGPU) when available and multi-threaded WebAssembly otherwise. The model downloads once (88 MB by default) and is then cached.
- `coi-serviceworker.js` enables cross-origin isolation on GitHub Pages, which multi-threaded WebAssembly needs.
- Animated GIFs are decoded with [gifuct-js](https://github.com/matt-way/gifuct-js), processed frame by frame, and re-encoded with [gif.js](https://github.com/jnordberg/gif.js). GIF only supports fully transparent or fully opaque pixels, so there's an edge-cutoff setting for transparent GIFs.
- iPhone HEIC photos are decoded with [heic-to](https://github.com/hoppergee/heic-to).

## Running locally

```
python serve.py
```

Then open http://localhost:8743. `serve.py` sends the COOP/COEP headers that enable multi-threaded WebAssembly.

## License note

The background-removal library is AGPL-licensed. That's fine for this open-source site; check its terms before using it in a closed-source product.
