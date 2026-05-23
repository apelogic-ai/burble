import {
  createHash,
  createSign,
  createVerify,
  generateKeyPairSync,
  type KeyObject
} from "node:crypto";

export type RuntimeJwtIssuer = ReturnType<typeof createRuntimeJwtIssuer>;

export type RuntimeJwtClaims = {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  runtime_id: string;
  workspace_id: string;
  slack_user_id: string;
};

export function createRuntimeJwtIssuer(input: {
  issuer: string;
  keyPair?: { publicKey: KeyObject; privateKey: KeyObject };
  now?: () => Date;
}) {
  const keyPair =
    input.keyPair ??
    generateKeyPairSync("rsa", {
      modulusLength: 2048
    });
  const publicJwk = keyPair.publicKey.export({ format: "jwk" }) as JsonWebKey;
  const kid = buildKeyId(publicJwk);
  const now = input.now ?? (() => new Date());

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

    issueRuntimeJwt(claims: {
      audience: string;
      runtimeId: string;
      workspaceId: string;
      slackUserId: string;
      ttlSeconds?: number;
    }): string {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const payload: RuntimeJwtClaims = {
        iss: input.issuer,
        aud: claims.audience,
        sub: `${claims.workspaceId}:${claims.slackUserId}`,
        iat: issuedAt,
        exp: issuedAt + (claims.ttlSeconds ?? 60 * 60),
        runtime_id: claims.runtimeId,
        workspace_id: claims.workspaceId,
        slack_user_id: claims.slackUserId
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

    verifyRuntimeJwt(inputJwt: {
      token: string;
      audience: string;
      now?: Date;
    }): RuntimeJwtClaims | null {
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
      if (!isRuntimeJwtClaims(payload)) {
        return null;
      }

      const timestamp = Math.floor((inputJwt.now ?? now()).getTime() / 1000);
      if (
        payload.iss !== input.issuer ||
        payload.aud !== inputJwt.audience ||
        payload.exp <= timestamp
      ) {
        return null;
      }

      return payload;
    }
  };
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

function isRuntimeJwtClaims(value: unknown): value is RuntimeJwtClaims {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.iss === "string" &&
    typeof record.aud === "string" &&
    typeof record.sub === "string" &&
    typeof record.iat === "number" &&
    typeof record.exp === "number" &&
    typeof record.runtime_id === "string" &&
    typeof record.workspace_id === "string" &&
    typeof record.slack_user_id === "string"
  );
}
