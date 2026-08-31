const { del } = require('@vercel/blob');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-sonnet-5';
const CLAUDE_MAX_TOKENS = 16000;

const GEMINI_MODEL = 'gemini-3.7-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_MAX_TOKENS = 16000;

const MAX_PAGES = 20;

const SYSTEM_PROMPT = `You are reviewing a scanned contractor invoice submitted to Sarasota County for disaster-related property repair reimbursement. The document may contain multiple pages including invoice/billing pages, scanned emails, and photo report pages showing the disaster damage itself.

Your job: identify the invoice/billing pages and extract the following structured data as JSON. Also examine any photo or damage-report pages (photos of storm/disaster damage to the property, before/after shots, inspection photos) and summarize what they show — do not ignore them.

Return ONLY a valid JSON object with these fields:
{
  "invoiceNumber": "",
  "invoiceDate": "",
  "dueDate": "",
  "vendorName": "",
  "vendorAddress": "",
  "vendorPhone": "",
  "customerName": "",
  "customerAddress": "",
  "propertyAddress": "",
  "customerId": "",
  "poNumber": "",
  "lineItems": [
    {
      "description": "",
      "amount": 0.00,
      "flagged": false,
      "flagReason": ""
    }
  ],
  "subtotal": 0.00,
  "balanceDue": 0.00,
  "damageAnalysis": {
    "photosDetected": false,
    "summary": "",
    "observations": []
  },
  "rawText": ""
}

Numeric field rules — apply these exactly:
- "amount", "subtotal", and "balanceDue" must be plain JSON numbers (e.g. 1234.56) — never strings, never containing "$" signs, commas, or quotes.
- "flagged" must be a plain JSON boolean (true or false) — never a string.

Raw text transcription rule:
- "rawText" must contain a full plain-text transcription of every readable piece of text found across every page of the document — invoice/billing text, headers, footers, scanned email text, photo captions, handwritten notes, everything — as close to verbatim as possible. Separate each page's content with a line reading "--- Page N ---". This is a complete transcript independent of the structured fields above; do not omit text just because it was already captured in another field.

Flagging rules — apply these exactly:
- Flag any line item with "markup" in the description: flagged: true, flagReason: "Materials markup is not reimbursable under county disaster relief guidelines"
- Flag any line item with "tax" in the description: flagged: true, flagReason: "Sarasota County is sales tax exempt — this charge is not claimable"
- All labor, materials, supplies, and credit card fees: flagged: false

Damage photo analysis rules:
- If the document contains any photo/damage-report pages (not just invoice text), set "photosDetected": true, write a 1-3 sentence "summary" of the overall damage shown (type of damage, apparent severity, affected areas), and list specific "observations" as short strings (e.g. "Roof shingles missing over southeast corner", "Water staining visible on interior ceiling drywall", "Downed tree resting on fence line").
- If there are no photo/damage-report pages at all (invoice-only document), set "photosDetected": false and leave "summary" as an empty string and "observations" as an empty array.
- Base observations only on what is visibly shown in the images — do not speculate beyond what is visible.

Return only the JSON object. No explanation, no markdown, no code fences.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    invoiceNumber: { type: 'string' },
    invoiceDate: { type: 'string' },
    dueDate: { type: 'string' },
    vendorName: { type: 'string' },
    vendorAddress: { type: 'string' },
    vendorPhone: { type: 'string' },
    customerName: { type: 'string' },
    customerAddress: { type: 'string' },
    propertyAddress: { type: 'string' },
    customerId: { type: 'string' },
    poNumber: { type: 'string' },
    lineItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount: { type: 'number' },
          flagged: { type: 'boolean' },
          flagReason: { type: 'string' },
        },
        required: ['description', 'amount', 'flagged', 'flagReason'],
        additionalProperties: false,
      },
    },
    subtotal: { type: 'number' },
    balanceDue: { type: 'number' },
    damageAnalysis: {
      type: 'object',
      properties: {
        photosDetected: { type: 'boolean' },
        summary: { type: 'string' },
        observations: { type: 'array', items: { type: 'string' } },
      },
      required: ['photosDetected', 'summary', 'observations'],
      additionalProperties: false,
    },
    rawText: { type: 'string' },
  },
  required: [
    'invoiceNumber', 'invoiceDate', 'dueDate', 'vendorName', 'vendorAddress', 'vendorPhone',
    'customerName', 'customerAddress', 'propertyAddress', 'customerId', 'poNumber',
    'lineItems', 'subtotal', 'balanceDue', 'damageAnalysis', 'rawText',
  ],
  additionalProperties: false,
};

// Gemini's structured-output schema dialect is a subset of OpenAPI 3.0 and does not
// recognize "additionalProperties" — strip it recursively rather than hand-maintaining
// a second copy of the schema that could drift out of sync with RESPONSE_SCHEMA.
function stripAdditionalProperties(node) {
  if (Array.isArray(node)) return node.map(stripAdditionalProperties);
  if (node && typeof node === 'object') {
    const copy = {};
    for (const key of Object.keys(node)) {
      if (key === 'additionalProperties') continue;
      copy[key] = stripAdditionalProperties(node[key]);
    }
    return copy;
  }
  return node;
}

const GEMINI_RESPONSE_SCHEMA = stripAdditionalProperties(RESPONSE_SCHEMA);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('No JSON object found in model response');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function stripDataUrlPrefix(base64) {
  const commaIndex = base64.indexOf(',');
  if (base64.startsWith('data:') && commaIndex !== -1) {
    return base64.slice(commaIndex + 1);
  }
  return base64;
}

function userInstruction(filename) {
  return `Extract the structured invoice data from the page images above (file: ${filename || 'unknown'}). Return only the JSON object described in your instructions.`;
}

async function fetchPageAsBase64(url) {
  // The Blob store is public, so the URL alone is fetchable with no auth — each blob is an
  // unguessable random path, and api/blob-upload.js + deleteBlobsQuietly below keep the
  // exposure window to just the few seconds between upload and this function reading it.
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch page image (${response.status}) from Blob storage`);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer).toString('base64');
}

async function deleteBlobsQuietly(urls) {
  // Best-effort cleanup — these are scanned government reimbursement documents, so we don't
  // want copies lingering in Blob storage any longer than it takes to process them. A failure
  // here shouldn't fail the actual extraction response the user is waiting on.
  await Promise.allSettled(urls.map((url) => del(url).catch(() => {})));
}

async function callClaude(apiKey, workspaceId, pages, filename) {
  const imageBlocks = pages.map((page) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: 'image/jpeg',
      data: stripDataUrlPrefix(page),
    },
  }));

  const userContent = [...imageBlocks, { type: 'text', text: userInstruction(filename) }];

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  // Multi-workspace API keys (tied to a person's identity across possibly several
  // workspaces, rather than one fixed workspace) require explicitly naming which
  // workspace the request acts in — see console.anthropic.com/settings/workspaces.
  if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;

  let response;
  try {
    response = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: {
          format: {
            type: 'json_schema',
            schema: RESPONSE_SCHEMA,
          },
        },
        messages: [{ role: 'user', content: userContent }],
      }),
    });
  } catch (err) {
    return { ok: false, error: `Claude request failed: ${err.message}` };
  }

  if (!response.ok) {
    const errText = await response.text();
    return { ok: false, error: `Claude API error (${response.status}): ${errText}` };
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((block) => block.type === 'text');

  if (!textBlock || !textBlock.text) {
    return { ok: false, error: 'Claude returned no text content' };
  }

  if (data.stop_reason === 'max_tokens') {
    return {
      ok: false,
      error: `Claude's response was cut off before finishing (hit the ${CLAUDE_MAX_TOKENS}-token limit) — this usually happens on long, multi-page documents.`,
    };
  }

  try {
    const extracted = extractJson(textBlock.text);
    return { ok: true, data: extracted, provider: 'Claude' };
  } catch (parseErr) {
    return { ok: false, error: `Failed to parse Claude's response as JSON: ${parseErr.message}` };
  }
}

async function callGemini(apiKey, pages, filename) {
  const imageParts = pages.map((page) => ({
    inline_data: {
      mime_type: 'image/jpeg',
      data: stripDataUrlPrefix(page),
    },
  }));

  const parts = [...imageParts, { text: userInstruction(filename) }];

  let response;
  try {
    response = await fetch(`${GEMINI_API_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          maxOutputTokens: GEMINI_MAX_TOKENS,
          responseMimeType: 'application/json',
          responseSchema: GEMINI_RESPONSE_SCHEMA,
        },
      }),
    });
  } catch (err) {
    return { ok: false, error: `Gemini request failed: ${err.message}` };
  }

  if (!response.ok) {
    const errText = await response.text();
    return { ok: false, error: `Gemini API error (${response.status}): ${errText}` };
  }

  const data = await response.json();
  const candidate = (data.candidates || [])[0];
  const textPart = candidate && (candidate.content?.parts || []).find((p) => typeof p.text === 'string');

  if (!textPart || !textPart.text) {
    return { ok: false, error: 'Gemini returned no text content (it may have been blocked by safety filters)' };
  }

  if (candidate.finishReason === 'MAX_TOKENS') {
    return {
      ok: false,
      error: `Gemini's response was cut off before finishing (hit the ${GEMINI_MAX_TOKENS}-token limit) — this usually happens on long, multi-page documents.`,
    };
  }

  try {
    const extracted = extractJson(textPart.text);
    return { ok: true, data: extracted, provider: 'Gemini' };
  } catch (parseErr) {
    return { ok: false, error: `Failed to parse Gemini's response as JSON: ${parseErr.message}` };
  }
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

  const { pageUrls, filename, claudeApiKey, claudeWorkspaceId, geminiApiKeys } = body || {};
  const claudeKey = claudeApiKey || process.env.ANTHROPIC_API_KEY;
  const geminiKeys = Array.isArray(geminiApiKeys) ? geminiApiKeys.filter(Boolean) : [];

  if (!claudeKey && geminiKeys.length === 0) {
    res.status(400).json({ error: 'No API key provided. Add a Claude key and/or at least one Gemini key in the app.' });
    return;
  }

  if (!Array.isArray(pageUrls) || pageUrls.length === 0) {
    res.status(400).json({ error: 'Request must include a non-empty "pageUrls" array (Blob storage URLs for each rendered page)' });
    return;
  }

  if (pageUrls.length > MAX_PAGES) {
    res.status(400).json({ error: `Too many pages (${pageUrls.length}). Maximum is ${MAX_PAGES}.` });
    return;
  }

  // Pages are uploaded client-side straight to Vercel Blob (bypassing this function's 4.5MB
  // request body limit entirely) and referenced here only by URL — fetch the actual bytes
  // server-side, where there's no such cap.
  let pages;
  try {
    pages = await Promise.all(pageUrls.map(fetchPageAsBase64));
  } catch (err) {
    await deleteBlobsQuietly(pageUrls);
    res.status(502).json({ error: `Could not retrieve uploaded page images: ${err.message}` });
    return;
  }

  const attempts = [];
  if (claudeKey) attempts.push({ label: 'Claude', run: () => callClaude(claudeKey, claudeWorkspaceId, pages, filename) });
  geminiKeys.forEach((key, i) => {
    attempts.push({ label: `Gemini (key #${i + 1})`, run: () => callGemini(key, pages, filename) });
  });

  const failures = [];

  for (const attempt of attempts) {
    let result;
    try {
      result = await attempt.run();
    } catch (err) {
      result = { ok: false, error: err.message || String(err) };
    }

    if (result.ok) {
      await deleteBlobsQuietly(pageUrls);
      res.status(200).json({ filename: filename || null, usedProvider: result.provider, ...result.data });
      return;
    }

    failures.push(`${attempt.label}: ${result.error}`);
  }

  await deleteBlobsQuietly(pageUrls);
  res.status(502).json({
    error: `All configured providers failed to extract this document.\n${failures.join('\n')}`,
  });
};
