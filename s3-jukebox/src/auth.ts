import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

export const SESSION_COOKIE = "jukebox_session";

/** Compares digests so the check is constant-time regardless of input length. */
export function passwordMatches(candidate: string): boolean {
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(config.password).digest();
  return timingSafeEqual(a, b);
}

export function issueSession(reply: FastifyReply): void {
  reply.setCookie(SESSION_COOKIE, String(Date.now()), {
    signed: true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    // Cookies are only marked Secure when the app is actually served over TLS;
    // this is usually terminated by a proxy in front of the container.
    secure: process.env.COOKIE_SECURE === "true",
    maxAge: config.sessionMaxAgeSeconds,
  });
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function isAuthenticated(request: FastifyRequest): boolean {
  const raw = request.cookies[SESSION_COOKIE];
  if (!raw) return false;

  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;

  const issuedAt = Number.parseInt(unsigned.value, 10);
  if (!Number.isFinite(issuedAt)) return false;

  const ageSeconds = (Date.now() - issuedAt) / 1000;
  return ageSeconds >= 0 && ageSeconds <= config.sessionMaxAgeSeconds;
}
