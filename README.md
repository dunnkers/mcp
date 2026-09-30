# mcp
Jeroen's MCP servers.

## Servers

- [`servers/hevy-mcp`](servers/hevy-mcp) — self-hosted [Hevy](https://www.hevyapp.com/)
  workout MCP server (upstream: [chrisdoc/hevy-mcp](https://github.com/chrisdoc/hevy-mcp)),
  deployed as a Cloudflare Worker. See [docs/hevy-mcp.md](docs/hevy-mcp.md) for
  setup and deploy details.
- [`servers/marktplaats-mcp`](servers/marktplaats-mcp) — TypeScript port of
  [dunnkers/marktplaats-mcp](https://github.com/dunnkers/marktplaats-mcp)
  (search and browse [Marktplaats.nl](https://www.marktplaats.nl) listings),
  deployed as a Cloudflare Worker. See
  [docs/marktplaats-mcp.md](docs/marktplaats-mcp.md) for setup and deploy
  details.
- [`servers/vinted-mcp`](servers/vinted-mcp) — self-hosted
  [Vinted](https://www.vinted.com) marketplace MCP server (upstream:
  [andrijdavid/vinted-mcp](https://github.com/andrijdavid/vinted-mcp)),
  with a [`worker/`](servers/vinted-mcp/worker) wrapper deployed as a
  Cloudflare Worker. See [docs/vinted-mcp.md](docs/vinted-mcp.md) for setup
  and deploy details.
- [`servers/bark-worker`](servers/bark-worker) — [Bark](https://github.com/Finb/Bark)
  push notification server (upstream:
  [cwxiaos/bark-worker](https://github.com/cwxiaos/bark-worker)), a
  Worker-native Bark-Server reimplementation with a built-in MCP endpoint,
  deployed as a Cloudflare Worker backed by D1. See
  [docs/bark-worker.md](docs/bark-worker.md) for setup and deploy details.
