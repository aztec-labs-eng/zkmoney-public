"use strict"

const crypto = require("node:crypto")
const fs = require("node:fs")
const path = require("node:path")
const selfsigned = require("selfsigned")

// In-process generation (node-forge via `selfsigned`) so Windows needs no openssl binary.
function generateCertificate({ hostname, certificateDays, tlsDirectory }) {
  fs.mkdirSync(tlsDirectory, { recursive: true, mode: 0o700 })

  const keyPath = path.join(tlsDirectory, "local.key.pem")
  const certPath = path.join(tlsDirectory, "local.cert.pem")
  const metadataPath = path.join(tlsDirectory, "metadata.json")

  const pems = selfsigned.generate([{ name: "commonName", value: hostname }], {
    days: certificateDays,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [{ type: 2 /* DNS */, value: hostname }] },
    ],
  })

  fs.writeFileSync(keyPath, pems.private, { encoding: "utf8", mode: 0o600 })
  fs.writeFileSync(certPath, pems.cert, { encoding: "utf8", mode: 0o644 })
  fs.writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        hostname,
        createdAt: new Date().toISOString(),
        certificateDays,
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  )

  return { keyPath, certPath, metadataPath }
}

function certificateMatchesHostname(certPem, hostname) {
  try {
    const certificate = new crypto.X509Certificate(certPem)
    return certificate.checkHost(hostname) === hostname
  } catch {
    return false
  }
}

// Regenerates on hostname mismatch, so retargeting (e.g. wallet.zk.money) is a config-only change.
function loadOrCreateCertificate(options) {
  const { hostname, certificateDays, tlsDirectory } = options
  const keyPath = path.join(tlsDirectory, "local.key.pem")
  const certPath = path.join(tlsDirectory, "local.cert.pem")

  let regenerate = !fs.existsSync(keyPath) || !fs.existsSync(certPath)

  if (!regenerate) {
    const certPem = fs.readFileSync(certPath, "utf8")
    regenerate = !certificateMatchesHostname(certPem, hostname)
  }

  if (regenerate) {
    generateCertificate({ hostname, certificateDays, tlsDirectory })
  }

  const keyPem = fs.readFileSync(keyPath, "utf8")
  const certPem = fs.readFileSync(certPath, "utf8")
  const certificate = new crypto.X509Certificate(certPem)

  const publicKeyDer = certificate.publicKey.export({
    type: "spki",
    format: "der",
  })

  const spkiSha256 = crypto.createHash("sha256").update(publicKeyDer).digest("base64")

  return {
    keyPem,
    certPem,
    keyPath,
    certPath,
    spkiSha256,
    validFrom: certificate.validFrom,
    validTo: certificate.validTo,
  }
}

module.exports = {
  certificateMatchesHostname,
  generateCertificate,
  loadOrCreateCertificate,
}
