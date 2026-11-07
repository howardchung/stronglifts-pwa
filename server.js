// Minimal static server for the PWA (no dependencies).
//
//   node server.js                     http://localhost:8080
//   node server.js 3000                http://localhost:3000
//   node server.js --https             https://<lan-ip>:8443 (self-signed cert auto-generated)
//   node server.js --https --cert cert.pem --key key.pem [--port 443] [--host 0.0.0.0]
//
// Env equivalents: HTTPS=1, PORT, HOST, SSL_CERT, SSL_KEY.
//
// Service workers, notifications and the File System Access API need a secure
// context: http://localhost works on the same machine, anything else (e.g. a
// phone on your LAN) needs HTTPS.
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = __dirname;

// ---------- args ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 ? argv[i + 1] : undefined;
};
const positionalPort = argv.find((a, i) => /^\d+$/.test(a) && !String(argv[i - 1]).startsWith('--'));

const useHttps = flag('https') || process.env.HTTPS === '1' || process.env.HTTPS === 'true';
const port = +(opt('port') || positionalPort || process.env.PORT || (useHttps ? 8443 : 8080));
const host = opt('host') || process.env.HOST || (useHttps ? '0.0.0.0' : 'localhost');
let certFile = opt('cert') || process.env.SSL_CERT;
let keyFile = opt('key') || process.env.SSL_KEY;

const lanIps = () =>
  Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);

// ---------- self-signed certificate ----------
function ensureSelfSignedCert() {
  const dir = path.join(root, '.certs');
  const cert = path.join(dir, 'cert.pem');
  const key = path.join(dir, 'key.pem');
  const sanFile = path.join(dir, 'san.txt');
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanIps().map((ip) => `IP:${ip}`), `DNS:${os.hostname()}`].join(',');

  const upToDate =
    fs.existsSync(cert) && fs.existsSync(key) && fs.existsSync(sanFile) && fs.readFileSync(sanFile, 'utf8') === san;
  if (!upToDate) {
    fs.mkdirSync(dir, { recursive: true });
    console.log('Generating self-signed certificate for:', san);
    try {
      execFileSync(
        'openssl',
        [
          'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
          '-keyout', key, '-out', cert,
          '-subj', '/CN=Stronglifts PWA (dev)',
          '-addext', `subjectAltName=${san}`,
          // CA:TRUE so the cert can be installed as its own trusted root (Android requires this).
          '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
          '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment,keyCertSign',
          '-addext', 'extendedKeyUsage=serverAuth',
        ],
        { stdio: ['ignore', 'ignore', 'pipe'] }
      );
    } catch (err) {
      console.error('Failed to generate a certificate with openssl. Install openssl or pass --cert/--key.');
      console.error(String(err.stderr || err.message));
      process.exit(1);
    }
    fs.writeFileSync(sanFile, san);
    fs.chmodSync(key, 0o600);
  }
  return { cert, key, selfSigned: true };
}

// ---------- request handler ----------
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};
const blocked = new Set(['scripts', 'server.js', 'package.json', 'README.md']);

function handler(req, res) {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, path.normalize(p));
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  // Never serve outside the root, dotfiles/dirs (e.g. .certs with the private key) or dev files.
  if (rel.startsWith('..') || parts.some((s) => s.startsWith('.')) || blocked.has(parts[0])) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------- start ----------
let server;
let selfSigned = false;
if (useHttps) {
  if (!!certFile !== !!keyFile) {
    console.error('Pass both --cert and --key (or neither to auto-generate a self-signed certificate).');
    process.exit(1);
  }
  if (!certFile) {
    ({ cert: certFile, key: keyFile, selfSigned } = ensureSelfSignedCert());
  }
  server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, handler);
} else {
  server = http.createServer(handler);
}

server.on('error', (err) => {
  console.error(`Server error: ${err.message}`);
  process.exit(1);
});

server.listen(port, host, () => {
  const scheme = useHttps ? 'https' : 'http';
  const hosts = host === '0.0.0.0' || host === '::' ? ['localhost', ...lanIps()] : [host];
  console.log('Stronglifts PWA running at:');
  hosts.forEach((h) => console.log(`  ${scheme}://${h}:${port}`));
  if (selfSigned) {
    console.log(
      '\nUsing a self-signed certificate (.certs/cert.pem). Browsers will show a warning, and Chrome\n' +
        'will not register the service worker (offline/install/notifications) until the certificate is\n' +
        'trusted. Install .certs/cert.pem as a trusted CA certificate on your phone, or use a trusted\n' +
        'certificate (e.g. from mkcert) with --cert/--key. See README for details.'
    );
  }
});
