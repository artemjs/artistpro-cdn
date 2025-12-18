/**
 * ARTISTPRO CDN Worker
 *
 * Handles R2 uploads and serves files with optional signed URLs
 *
 * Endpoints:
 * - POST /upload          - Upload file (multipart form)
 * - POST /upload-base64   - Upload base64 image
 * - POST /upload-url      - Upload from external URL
 * - GET  /signed/:key     - Get temporary signed URL
 * - GET  /temp/:key       - Access file via signed URL
 * - GET  /:key            - Direct public access
 * - DELETE /:key          - Delete file
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check
      if (path === '/health') {
        return json({ status: 'healthy', service: 'artistpro-cdn' }, 200, corsHeaders);
      }

      // POST /upload - upload file (multipart form)
      if (path === '/upload' && request.method === 'POST') {
        return await handleUpload(request, env, corsHeaders, getBaseUrl(request));
      }

      // POST /upload-base64 - upload base64 image
      if (path === '/upload-base64' && request.method === 'POST') {
        return await handleBase64Upload(request, env, corsHeaders, getBaseUrl(request));
      }

      // POST /upload-url - upload from external URL
      if (path === '/upload-url' && request.method === 'POST') {
        return await handleUrlUpload(request, env, corsHeaders, getBaseUrl(request));
      }

      // GET /signed/:key - get signed URL for existing file
      if (path.startsWith('/signed/')) {
        const key = decodeURIComponent(path.replace('/signed/', ''));
        return await getSignedUrl(key, env, url, corsHeaders, getBaseUrl(request));
      }

      // GET /temp/:key - access via signed URL
      if (path.startsWith('/temp/')) {
        return await handleTempAccess(path, url, env, corsHeaders);
      }

      // DELETE /:key - delete file
      if (request.method === 'DELETE' && path !== '/') {
        const key = decodeURIComponent(path.slice(1));
        return await handleDelete(key, env, corsHeaders);
      }

      // GET /* - direct file access (public CDN)
      if (request.method === 'GET' && path !== '/') {
        const key = decodeURIComponent(path.slice(1));
        return await serveFile(key, env, corsHeaders, request);
      }

      // Root
      if (path === '/') {
        return json({
          service: 'artistpro-cdn',
          endpoints: [
            'POST /upload - upload file',
            'POST /upload-base64 - upload base64',
            'POST /upload-url - upload from URL',
            'GET /signed/:key - get temp URL',
            'GET /temp/:key - access via temp URL',
            'GET /:key - direct access',
            'DELETE /:key - delete file'
          ]
        }, 200, corsHeaders);
      }

      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (e) {
      console.error('Worker error:', e);
      return json({ error: e.message }, 500, corsHeaders);
    }
  }
};

// ============================================
// Upload Handlers
// ============================================

async function handleUpload(request, env, cors, baseUrl) {
  const formData = await request.formData();
  const file = formData.get('file');
  const folder = formData.get('folder') || 'uploads';
  const customName = formData.get('name');

  if (!file) {
    return json({ error: 'No file provided' }, 400, cors);
  }

  const ext = getExtension(file.name, file.type);
  const filename = customName || crypto.randomUUID();
  const key = `${folder}/${filename}.${ext}`;

  await env.BUCKET.put(key, file.stream(), {
    httpMetadata: { contentType: file.type }
  });

  return json({
    success: true,
    key,
    url: `${baseUrl}/${key}`,
    temp_url: await generateTempUrl(key, env, 3600, baseUrl)
  }, 200, cors);
}

async function handleBase64Upload(request, env, cors, baseUrl) {
  const body = await request.json();
  const { data, filename, folder = 'uploads', content_type } = body;

  if (!data) {
    return json({ error: 'No data provided' }, 400, cors);
  }

  // Remove data:image/...;base64, prefix if present
  let base64Data = data;
  let detectedType = content_type || 'image/png';

  const match = data.match(/^data:([^;]+);base64,/);
  if (match) {
    detectedType = match[1];
    base64Data = data.replace(/^data:[^;]+;base64,/, '');
  }

  const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));

  const ext = getExtension(filename, detectedType);
  const name = filename?.replace(/\.[^.]+$/, '') || crypto.randomUUID();
  const key = `${folder}/${name}.${ext}`;

  await env.BUCKET.put(key, buffer, {
    httpMetadata: { contentType: detectedType }
  });

  return json({
    success: true,
    key,
    url: `${baseUrl}/${key}`,
    temp_url: await generateTempUrl(key, env, 3600, baseUrl),
    size: buffer.length
  }, 200, cors);
}

async function handleUrlUpload(request, env, cors, baseUrl) {
  const { url: sourceUrl, folder = 'uploads', filename } = await request.json();

  if (!sourceUrl) {
    return json({ error: 'No URL provided' }, 400, cors);
  }

  // Fetch the image
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    return json({ error: `Failed to fetch: ${response.status}` }, 400, cors);
  }

  const contentType = response.headers.get('content-type') || 'image/png';
  const buffer = await response.arrayBuffer();

  const ext = getExtension(filename, contentType);
  const name = filename?.replace(/\.[^.]+$/, '') || crypto.randomUUID();
  const key = `${folder}/${name}.${ext}`;

  await env.BUCKET.put(key, buffer, {
    httpMetadata: { contentType }
  });

  return json({
    success: true,
    key,
    url: `${baseUrl}/${key}`,
    temp_url: await generateTempUrl(key, env, 3600, baseUrl),
    size: buffer.byteLength,
    source: sourceUrl
  }, 200, cors);
}

// ============================================
// Signed URL Generation & Verification
// ============================================

async function generateTempUrl(key, env, expiresIn = 3600, baseUrl = 'https://cdn.artistpro.me') {
  const expires = Math.floor(Date.now() / 1000) + expiresIn;
  const token = await signData(`${key}:${expires}`, env.SIGNING_SECRET);
  return `${baseUrl}/temp/${encodeURIComponent(key)}?expires=${expires}&token=${token}`;
}

async function signData(data, secret) {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function verifySignature(data, token, secret) {
  const expectedToken = await signData(data, secret);
  return token === expectedToken;
}

async function getSignedUrl(key, env, url, cors, baseUrl) {
  const expiresIn = parseInt(url.searchParams.get('expires_in') || '3600');

  // Check file exists
  const object = await env.BUCKET.head(key);
  if (!object) {
    return json({ error: 'File not found' }, 404, cors);
  }

  const tempUrl = await generateTempUrl(key, env, expiresIn, baseUrl);

  return json({
    key,
    url: `${baseUrl}/${key}`,
    temp_url: tempUrl,
    expires_in: expiresIn,
    size: object.size,
    content_type: object.httpMetadata?.contentType
  }, 200, cors);
}

async function handleTempAccess(path, url, env, cors) {
  const key = decodeURIComponent(path.replace('/temp/', ''));
  const expires = url.searchParams.get('expires');
  const token = url.searchParams.get('token');

  if (!expires || !token) {
    return json({ error: 'Missing expires or token' }, 400, cors);
  }

  // Check expiration
  if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
    return json({ error: 'Link expired' }, 403, cors);
  }

  // Verify signature
  const isValid = await verifySignature(`${key}:${expires}`, token, env.SIGNING_SECRET);
  if (!isValid) {
    return json({ error: 'Invalid token' }, 403, cors);
  }

  return await serveFile(key, env, cors);
}

// ============================================
// File Operations
// ============================================

async function serveFile(key, env, cors, request = null) {
  // Handle conditional requests (ETag)
  if (request) {
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch) {
      const object = await env.BUCKET.head(key);
      if (object && ifNoneMatch === object.etag) {
        return new Response(null, { status: 304, headers: cors });
      }
    }
  }

  const object = await env.BUCKET.get(key);

  if (!object) {
    return json({ error: 'Not found' }, 404, cors);
  }

  const headers = new Headers(cors);
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream');
  headers.set('Content-Length', object.size);
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  headers.set('ETag', object.etag);

  // Add content disposition for downloads if requested
  const url = request ? new URL(request.url) : null;
  if (url?.searchParams.get('download') === 'true') {
    const filename = key.split('/').pop();
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  }

  return new Response(object.body, { headers });
}

async function handleDelete(key, env, cors) {
  const object = await env.BUCKET.head(key);

  if (!object) {
    return json({ error: 'File not found' }, 404, cors);
  }

  await env.BUCKET.delete(key);

  return json({ success: true, deleted: key }, 200, cors);
}

// ============================================
// Utilities
// ============================================

function getExtension(filename, contentType) {
  // Try from filename first
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (ext && ext.length <= 5) return ext;
  }

  // Fall back to content type
  const typeMap = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'application/pdf': 'pdf',
  };

  return typeMap[contentType] || 'bin';
}

function json(data, status = 200, cors = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors }
  });
}

// Get base URL from request (handles both cdn.artistpro.me and workers.dev fallback)
function getBaseUrl(request) {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
