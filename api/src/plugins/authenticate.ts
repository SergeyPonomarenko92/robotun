import fp from "fastify-plugin";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { verifyAccessToken } from "../services/crypto.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the `authenticate` pre-handler decorator. Always re-reads
     *  user.ver from DB per spec §SEC-006 so a logout-all / password
     *  change / suspend invalidates outstanding access tokens. */
    auth?: {
      user_id: string;
      email: string;
      display_name: string;
      has_provider_role: boolean;
      kyc_status: string;
      payout_enabled: boolean;
      mfa_enrolled: boolean;
      status: string;
    };
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest) => Promise<void>;
  }
}

const plugin: FastifyPluginAsync = async (fastify) => {
  fastify.decorate("authenticate", async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      throw fastify.httpErrors.unauthorized("missing_token");
    }
    const token = header.slice("Bearer ".length).trim();
    const claims = await verifyAccessToken(token);
    if (!claims) {
      throw fastify.httpErrors.unauthorized("invalid_token");
    }
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.id, claims.sub))
      .limit(1);
    const user = rows[0];
    if (!user) throw fastify.httpErrors.unauthorized("user_not_found");
    if (user.ver !== claims.ver) {
      throw fastify.httpErrors.unauthorized("token_expired");
    }
    if (user.status === "suspended" || user.status === "deleted") {
      throw fastify.httpErrors.forbidden("account_disabled");
    }
    req.auth = {
      user_id: user.id,
      email: user.email,
      display_name: user.display_name,
      has_provider_role: user.has_provider_role,
      kyc_status: user.kyc_status,
      payout_enabled: user.payout_enabled,
      mfa_enrolled: user.mfa_enrolled,
      status: user.status,
    };
  });
};

export default fp(plugin, { name: "authenticate" });
