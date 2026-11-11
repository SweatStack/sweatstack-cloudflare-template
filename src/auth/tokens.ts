// Stores each user's SweatStack tokens in D1 (encrypted) and hands out valid access tokens.
//
// Why this file is careful: SweatStack ROTATES refresh tokens. Every refresh returns a new refresh
// token, and the old one stops working after a short grace window (15 to 60 seconds). If two requests
// for the same user refresh at once (two tabs, or a burst of webhooks during a backfill), they would
// race and one of them could end up storing a dead token. So refreshes are serialized with a lease:
//
//   1. A request that needs a refresh takes the lease with a conditional UPDATE (only one can win).
//   2. The winner refreshes, stores the new tokens, and releases the lease.
//   3. Everyone else waits for the stored access token to change, then uses it.
//
// The lease expires after LEASE_MS (10 s), on purpose shorter than SweatStack's minimum grace window
// (15 s): if the lease holder crashes mid-refresh, the next request takes over and can still use the old
// refresh token. D1 has a single primary, so the conditional UPDATE is a real lock.

import type { Config } from "../config";
import { decryptString, encryptString } from "../lib/crypto";
import { NotAuthenticatedError, SweatStackError, type Fetch } from "../sweatstack/http";
import { refreshTokens } from "../sweatstack/oauth";
import type { TokenResponse } from "../sweatstack/types";

const LEASE_MS = 10_000;
const WAIT_MS = 8_000;
const POLL_MS = 200;
/** Refresh a little before expiry, so a token never expires mid-request. */
const EXPIRY_MARGIN_MS = 60_000;

type TokenRow = {
  access_token_enc: string;
  access_expires_at: number;
  refresh_token_enc: string;
  refresh_lock_until: number | null;
};

export type TokenStoreOptions = { leaseMs?: number; waitMs?: number; pollMs?: number };

export class TokenStore {
  private readonly leaseMs: number;
  private readonly waitMs: number;
  private readonly pollMs: number;

  constructor(
    private readonly db: D1Database,
    private readonly key: CryptoKey,
    private readonly config: Config,
    private readonly fetchFn: Fetch,
    options: TokenStoreOptions = {},
  ) {
    this.leaseMs = options.leaseMs ?? LEASE_MS;
    this.waitMs = options.waitMs ?? WAIT_MS;
    this.pollMs = options.pollMs ?? POLL_MS;
  }

  /** Creates or updates a user after sign-in. */
  async saveUser(userId: string, name: string | null, tokens: TokenResponse): Promise<void> {
    if (!tokens.refresh_token) throw new Error("SweatStack returned no refresh token");
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO users (id, name, access_token_enc, access_expires_at, refresh_token_enc, refresh_lock_until, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)
         ON CONFLICT (id) DO UPDATE SET
           name = excluded.name,
           access_token_enc = excluded.access_token_enc,
           access_expires_at = excluded.access_expires_at,
           refresh_token_enc = excluded.refresh_token_enc,
           refresh_lock_until = NULL,
           last_seen_at = excluded.last_seen_at`,
      )
      .bind(
        userId,
        name,
        await encryptString(this.key, tokens.access_token),
        expiresAt(tokens),
        await encryptString(this.key, tokens.refresh_token),
        now,
      )
      .run();
  }

  /**
   * A valid access token for this user, refreshed if it is (nearly) expired.
   * `forceRefresh`: the API rejected the current token (401), so get a new one regardless of expiry.
   * Throws NotAuthenticatedError when the user has no stored tokens or SweatStack refused the refresh.
   */
  async getAccessToken(userId: string, { forceRefresh = false }: { forceRefresh?: boolean } = {}): Promise<string> {
    const row = await this.read(userId);
    if (!forceRefresh && row.access_expires_at - Date.now() > EXPIRY_MARGIN_MS) {
      return decryptString(this.key, row.access_token_enc);
    }
    return this.refresh(userId, row);
  }

  private async refresh(userId: string, seen: TokenRow): Promise<string> {
    const now = Date.now();
    const lease = await this.db
      .prepare(
        "UPDATE users SET refresh_lock_until = ?1 WHERE id = ?2 AND (refresh_lock_until IS NULL OR refresh_lock_until < ?3)",
      )
      .bind(now + this.leaseMs, userId, now)
      .run();

    if (lease.meta.changes !== 1) return this.waitForRefresh(userId, seen);

    try {
      // Someone may have finished a refresh between our read and taking the lease.
      const current = await this.read(userId);
      if (current.access_token_enc !== seen.access_token_enc) {
        await this.releaseLease(userId);
        return decryptString(this.key, current.access_token_enc);
      }

      const refreshToken = await decryptString(this.key, current.refresh_token_enc);
      let tokens: TokenResponse;
      try {
        tokens = await refreshTokens(this.fetchFn, this.config, refreshToken);
      } catch (error) {
        if (error instanceof SweatStackError && error.code === "invalid_grant") {
          // The user revoked access, or the refresh token expired. Their connection is gone.
          await this.deleteUser(userId);
          throw new NotAuthenticatedError("SweatStack connection ended; sign in again");
        }
        throw error;
      }

      const accessEnc = await encryptString(this.key, tokens.access_token);
      // With rotation SweatStack always returns a new refresh token; keep the old one if it ever doesn't.
      const refreshEnc = tokens.refresh_token
        ? await encryptString(this.key, tokens.refresh_token)
        : current.refresh_token_enc;
      await this.db
        .prepare(
          `UPDATE users SET access_token_enc = ?1, access_expires_at = ?2, refresh_token_enc = ?3, refresh_lock_until = NULL
           WHERE id = ?4`,
        )
        .bind(accessEnc, expiresAt(tokens), refreshEnc, userId)
        .run();
      return tokens.access_token;
    } catch (error) {
      await this.releaseLease(userId).catch(() => {});
      throw error;
    }
  }

  /** Another request holds the lease: wait until it stores a new token, or take over if it gave up. */
  private async waitForRefresh(userId: string, seen: TokenRow): Promise<string> {
    const deadline = Date.now() + this.waitMs;
    while (Date.now() < deadline) {
      await sleep(this.pollMs);
      const row = await this.read(userId);
      if (row.access_token_enc !== seen.access_token_enc) return decryptString(this.key, row.access_token_enc);
      if (row.refresh_lock_until === null || row.refresh_lock_until < Date.now()) return this.refresh(userId, row);
    }
    throw new SweatStackError("Timed out waiting for a token refresh", 503);
  }

  private async read(userId: string): Promise<TokenRow> {
    const row = await this.db
      .prepare(
        "SELECT access_token_enc, access_expires_at, refresh_token_enc, refresh_lock_until FROM users WHERE id = ?",
      )
      .bind(userId)
      .first<TokenRow>();
    if (!row) throw new NotAuthenticatedError();
    return row;
  }

  private async releaseLease(userId: string): Promise<void> {
    await this.db.prepare("UPDATE users SET refresh_lock_until = NULL WHERE id = ?").bind(userId).run();
  }

  /** Removes the user, their tokens and (by cascade) their push subscriptions. */
  async deleteUser(userId: string): Promise<void> {
    await this.db.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();
  }
}

function expiresAt(tokens: TokenResponse): number {
  return Date.now() + Math.max(0, tokens.expires_in) * 1000;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
