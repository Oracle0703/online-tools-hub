# QR code fixtures

These files are checked-in browser fixtures for Issue #52. They contain only synthetic data and no user content.

- `unicode.png`: static PNG encoding `二维码识别 fixture · Unicode 👋`.
- `rotated.jpg`: the same code rotated 90° and encoded as JPEG.
- `inverted.webp`: the same code with inverted colors in lossless WebP.
- `low-resolution.png`: the same code rasterized at 112 × 112 px.
- `unsafe-url.png`: synthetic `javascript:` and `https://canary.invalid/` text used to prove scan results never navigate or request.
- `no-qr.png`: a plain local image with no code.
- `corrupt.png`: a deliberately truncated PNG signature/header.
- `animated.webp`: a valid two-frame 64 × 64 animated WebP used to prove animation is rejected before decode.
- `over-limit.png`: a valid, highly compressed 4001 × 4000 PNG whose 16,004,000 pixels exceed the 16 MP source budget.

The positive rasters were generated offline from `uqr@0.1.3` matrices and encoded with the repository-pinned Sharp toolchain. Tests decode the committed bytes; they do not generate them at runtime. `jsQR@1.4.0` is not used to create any fixture.

The two rejection fixtures are real image containers generated offline with ImageMagick: `animated.webp` contains two frames, while `over-limit.png` uses a uniform palette so the committed file stays small without falsifying its dimensions.
