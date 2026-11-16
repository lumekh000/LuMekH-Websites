# LuMekH-Websites
LuMekH Websites web app project

## MCP catalog connection

The public catalog MCP endpoint is `https://lumekh.com/mcp` and uses the Streamable HTTP transport. Create an API key from **Admin → Integrations**, then configure an MCP client with:

```json
{
  "mcpServers": {
    "lumekh": {
      "url": "https://lumekh.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

The server provides read-only `list_products`, `get_product`, and `list_services` tools. It does not expose customer accounts, order history, or booking records. API keys are shown only once, stored as SHA-256 hashes, can be revoked in the admin panel, and are limited to 120 requests per minute per key.

## Webhooks

Configure an HTTPS public destination under **Admin → Integrations**. Supported events are `order.created` and `booking.created`. Every delivery includes `id`, `type`, `createdAt`, and `data`, plus `X-LuMekH-Event`, `X-LuMekH-Delivery`, `X-LuMekH-Timestamp`, and `X-LuMekH-Signature` headers. The signature is `t=<unix-seconds>,v1=<hex HMAC-SHA256>` over `<timestamp>.<raw request body>` using the one-time `whsec_...` secret. Compare timestamps and use a constant-time comparison when validating signatures.

Deliveries are retried up to six times with increasing delays; the admin panel shows recent statuses and allows manual retry of failed deliveries. Destinations must resolve exclusively to public IP addresses; requests are pinned to a validated address and do not follow redirects. Event payloads contain order or booking IDs, product/service identifiers, dates, item details, and totals; they do not include customer contact details. Secrets are encrypted at rest using `GOOGLE_TOKEN_ENCRYPTION_KEY` (or the database password as the existing application fallback).
