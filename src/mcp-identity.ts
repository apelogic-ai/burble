import {
  createHash,
  createPrivateKey,
  createPublicKey,
  createSign,
  createVerify,
  generateKeyPairSync,
  randomUUID,
  type KeyObject
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type McpIdentityIssuer = ReturnType<typeof createMcpIdentityIssuer>;

export type McpIdentityClaims = {
  iss: string;
  aud: string;
  sub: string;
  email: string;
  workspace_id: string;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

export function createMcpIdentityIssuer(input: {
  issuer: string;
  keyPair?: { publicKey: KeyObject; privateKey: KeyObject };
  privateKeyPath?: string | null;
  now?: () => Date;
  randomId?: () => string;
}) {
  const keyPair = input.keyPair ?? loadOrCreateKeyPair(input.privateKeyPath);
  const publicJwk = keyPair.publicKey.export({ format: "jwk" }) as JsonWebKey;
  const kid = buildKeyId(publicJwk);
  const now = input.now ?? (() => new Date());
  const randomId = input.randomId ?? randomUUID;

  return {
    issuer: input.issuer,
    jwks() {
      return {
        keys: [
          {
            ...publicJwk,
            kid,
            alg: "RS256",
            use: "sig"
          }
        ]
      };
    },

    issueUserAssertion(claims: {
      audience: string;
      subject: string;
      workspaceId: string;
      email: string;
      ttlSeconds?: number;
    }): string {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const payload: McpIdentityClaims = {
        iss: input.issuer,
        aud: claims.audience,
        sub: claims.subject,
        email: claims.email,
        workspace_id: claims.workspaceId,
        iat: issuedAt,
        nbf: issuedAt,
        exp: issuedAt + (claims.ttlSeconds ?? 5 * 60),
        jti: randomId()
      };

      const signingInput = `${base64UrlJson({
        alg: "RS256",
        typ: "JWT",
        kid
      })}.${base64UrlJson(payload)}`;
      const signature = createSign("RSA-SHA256")
        .update(signingInput)
        .sign(keyPair.privateKey);

      return `${signingInput}.${base64Url(signature)}`;
    },

    verifyUserAssertion(inputJwt: {
      token: string;
      audience: string;
      now?: Date;
    }): McpIdentityClaims | null {
      const parts = inputJwt.token.split(".");
      if (parts.length !== 3) {
        return null;
      }

      const [headerRaw, payloadRaw, signatureRaw] = parts;
      const header = parseBase64UrlJson(headerRaw);
      if (!header || header.alg !== "RS256" || header.kid !== kid) {
        return null;
      }

      const verified = createVerify("RSA-SHA256")
        .update(`${headerRaw}.${payloadRaw}`)
        .verify(keyPair.publicKey, Buffer.from(signatureRaw, "base64url"));
      if (!verified) {
        return null;
      }

      const payload = parseBase64UrlJson(payloadRaw);
      if (!isMcpIdentityClaims(payload)) {
        return null;
      }

      const timestamp = Math.floor((inputJwt.now ?? now()).getTime() / 1000);
      if (
        payload.iss !== input.issuer ||
        payload.aud !== inputJwt.audience ||
        payload.nbf > timestamp ||
        payload.exp <= timestamp
      ) {
        return null;
      }

      return payload;
    }
  };
}

function loadOrCreateKeyPair(path: string | null | undefined): {
  publicKey: KeyObject;
  privateKey: KeyObject;
} {
  if (!path) {
    return generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
  }

  if (existsSync(path)) {
    const privateKey = createPrivateKey(readFileSync(path, "utf8"));
    return {
      privateKey,
      publicKey: createPublicKey(privateKey)
    };
  }

  const keyPair = generateKeyPairSync("rsa", {
    modulusLength: 2048
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    keyPair.privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 }
  );

  return keyPair;
}

function buildKeyId(jwk: JsonWebKey): string {
  return base64Url(
    createHash("sha256")
      .update(JSON.stringify({ kty: jwk.kty, n: jwk.n, e: jwk.e }))
      .digest()
  ).slice(0, 16);
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

function parseBase64UrlJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed ? parsed : null;
  } catch {
    return null;
  }
}

function isMcpIdentityClaims(value: unknown): value is McpIdentityClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.iss === "string" &&
    typeof record.aud === "string" &&
    typeof record.sub === "string" &&
    typeof record.email === "string" &&
    typeof record.workspace_id === "string" &&
    typeof record.iat === "number" &&
    typeof record.nbf === "number" &&
    typeof record.exp === "number" &&
    typeof record.jti === "string"
  );
}
