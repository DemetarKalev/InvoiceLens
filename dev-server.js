const http = require('http');
const fs = require('fs');
const path = require('path');
const extractHandler = require('./api/extract.js');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = decodeURIComponent(filePath.split('?')[0]);
  const fullPath = path.join(ROOT, filePath);

  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(fullPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
    res.end(data);
  });
}

function makeVercelResponse(res) {
  return {
    _status: 200,
    setHeader: (k, v) => res.setHeader(k, v),
    status(code) {
      this._status = code;
      return this;
    },
    json(obj) {
      res.writeHead(this._status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    },
    end(body) {
      res.writeHead(this._status);
      res.end(body);
    },
  };
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/extract')) {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      let body = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }
      const fakeReq = { method: req.method, body };
      const fakeRes = makeVercelResponse(res);
      try {
        await extractHandler(fakeReq, fakeRes);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`InvoiceLens dev server running at http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('WARNING: ANTHROPIC_API_KEY is not set — extraction requests will fail.');
  }
});
