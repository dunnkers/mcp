# voice-memo-summarizer

Cloudflare Worker that sends anything POSTed to it to Gemini (via
[`@google/genai`](https://github.com/googleapis/js-genai) on Vertex AI) and
returns a faithful text transcription/description. See
[docs/voice-memo-summarizer.md](../../docs/voice-memo-summarizer.md).
