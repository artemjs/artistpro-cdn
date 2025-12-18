# ARTISTPRO CDN Worker

Cloudflare Worker для R2 с поддержкой временных подписанных ссылок.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check |
| POST | `/upload` | Upload file (multipart form) |
| POST | `/upload-base64` | Upload base64 encoded image |
| POST | `/upload-url` | Upload from external URL |
| GET | `/signed/:key` | Get temporary signed URL |
| GET | `/temp/:key?expires=&token=` | Access via signed URL |
| GET | `/:key` | Direct public access |
| DELETE | `/:key` | Delete file |

## Usage Examples

### Upload base64 image
```bash
curl -X POST https://cdn.artistpro.me/upload-base64 \
  -H "Content-Type: application/json" \
  -d '{"data": "data:image/png;base64,iVBOR...", "folder": "covers"}'
```

### Upload from URL
```bash
curl -X POST https://cdn.artistpro.me/upload-url \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/image.png", "folder": "references"}'
```

### Get signed URL (1 hour)
```bash
curl "https://cdn.artistpro.me/signed/covers/abc123.png?expires_in=3600"
```

### Direct access
```bash
curl https://cdn.artistpro.me/covers/abc123.png
```

## Response Format

```json
{
  "success": true,
  "key": "covers/abc123.png",
  "url": "https://cdn.artistpro.me/covers/abc123.png",
  "temp_url": "https://cdn.artistpro.me/temp/covers%2Fabc123.png?expires=1234567890&token=xxx"
}
```

## Deployment

```bash
# Install dependencies
npm install

# Set secret (do this once)
npx wrangler secret put SIGNING_SECRET

# Deploy
npm run deploy
```

## Configuration

Edit `wrangler.toml`:

```toml
name = "artistpro-cdn"
main = "src/index.js"

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "artistpro"

routes = [
  { pattern = "cdn.artistpro.me/*", zone_name = "artistpro.me" }
]
```
