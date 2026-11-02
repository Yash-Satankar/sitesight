# SiteSight Meta proxy

Meta's Model API answers `model_not_found` (and lists no models) for requests from Railway's network, while the same
key works from India. This Vercel project, pinned to `bom1` (Mumbai), forwards only the model calls SiteSight makes:

- `POST /v1/responses` (Muse Spark, SAM 3.1)
- `POST /v1/asr/transcribe` (Muse Voice Transcribe)

Each request must send `X-Meta-Proxy-Secret`; the real `META_API_KEY` is held here and replaces the caller's
Authorization. Bodies are capped at 4.4 MB (Vercel's limit is 4.5 MB) and never logged. Anything else gets 401/404/405.

Vercel env: `META_API_KEY`, `META_PROXY_SECRET`. SiteSight API env: `META_BASE_URL=https://<proxy>.vercel.app/v1`,
`META_PROXY_SECRET` (same value).

Deploy: `cd meta-proxy && vercel deploy --prod`.
