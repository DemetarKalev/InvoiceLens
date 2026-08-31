const { handleUpload } = require('@vercel/blob/client');

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {
      res.status(400).json({ error: 'Invalid JSON body' });
      return;
    }
  }

  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
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

    res.status(200).json(jsonResponse);
  } catch (error) {
    res.status(500).json({
      error: `handleUpload failed: ${error && error.message ? error.message : String(error)}`,
    });
  }
};
