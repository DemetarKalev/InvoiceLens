import { handleUpload } from '@vercel/blob/client';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405, headers: CORS_HEADERS });
  }

  const body = await request.json();

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        // No end-user login system here — the app itself is gated by requiring an
        // AI API key before any upload happens, which is this app's access control.
        return {
          allowedContentTypes: ['image/jpeg'],
          addRandomSuffix: true,
        };
      },
      onUploadCompleted: async () => {
        // No-op: the browser already receives the blob URL directly from upload(),
        // and api/extract.js deletes each blob right after it reads it.
      },
    });

    return Response.json(jsonResponse, { headers: CORS_HEADERS });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400, headers: CORS_HEADERS });
  }
}
