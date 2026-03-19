// src/services/billing-service.ts
// Billing service for AltMe Telegram bot.
// Manages token balances, tariff packages, group ownership, and coupon redemption.

import { Pool } from 'pg';

// ──────────────────────────────────────────────────────────────────────────────
// Tariff packages: Stars → tokens (with bonuses)
// ──────────────────────────────────────────────────────────────────────────────

export const TARIFF_PACKAGES = [
  { id: 'starter',  label: 'Starter',  stars: 60,   tokens: 600 },
  { id: 'basic',    label: 'Basic',    stars: 120,  tokens: 1_320 },
  { id: 'standard', label: 'Standard', stars: 300,  tokens: 3_600 },
  { id: 'pro',      label: 'Pro',      stars: 600,  tokens: 9_000 },
  { id: 'business', label: 'Business', stars: 1500, tokens: 22_500 },
  { id: 'max',      label: 'Max',      stars: 3000, tokens: 54_000 },
] as const;

export type TariffPackage = typeof TARIFF_PACKAGES[number];

// ──────────────────────────────────────────────────────────────────────────────
// Token costs per action
// ──────────────────────────────────────────────────────────────────────────────

export const ACTION_COSTS: Record<string, number> = {
  text_message: 1,
  voice_message: 2,
  search_quick: 3,
  send_html_document: 5,
  web_research: 25,
};

// ──────────────────────────────────────────────────────────────────────────────
// BillingService
// ──────────────────────────────────────────────────────────────────────────────

export class BillingService {
  private readonly pool: Pool;

  constructor(postgresUrl: string) {
    this.pool = new Pool({ connectionString: postgresUrl });
  }

  /**
   * Drain the connection pool. Call on application shutdown.
   */
  async close(): Promise<void> {
    await this.pool.end();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Balance operations
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get the current token balance for a user.
   * Returns 0 if the user has no balance record.
   */
  async getBalance(userId: number): Promise<number> {
    const result = await this.pool.query<{ tokens: number }>(
      `SELECT tokens FROM user_balances WHERE user_id = $1`,
      [userId],
    );

    return result.rows[0]?.tokens ?? 0;
  }

  /**
   * Credit tokens to a user's balance and record the transaction.
   */
  async creditTokens(userId: number, amount: number, action: string, extra?: {
    stars?: number;
    telegramPaymentChargeId?: string;
    contextId?: string;
  }): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO user_balances (user_id, tokens, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE
         SET tokens = user_balances.tokens + $2, updated_at = now()`,
        [userId, amount],
      );

      await client.query(
        `INSERT INTO transactions (user_id, delta, action, stars, telegram_payment_charge_id, context_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          userId,
          amount,
          action,
          extra?.stars ?? null,
          extra?.telegramPaymentChargeId ?? null,
          extra?.contextId ?? null,
        ],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Deduct tokens from a user's balance.
   * Returns false if the user has insufficient balance (no partial deduction).
   */
  async deductTokens(userId: number, amount: number, action: string, contextId?: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(
        `UPDATE user_balances
         SET tokens = tokens - $2, updated_at = now()
         WHERE user_id = $1 AND tokens >= $2`,
        [userId, amount],
      );

      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      await client.query(
        `INSERT INTO transactions (user_id, delta, action, context_id)
         VALUES ($1, $2, $3, $4)`,
        [userId, -amount, action, contextId ?? null],
      );

      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Group ownership
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Get the owner of a group (the user who pays for group usage).
   * Returns null if no owner is registered.
   */
  async getGroupOwner(groupId: number): Promise<number | null> {
    const result = await this.pool.query<{ owner_id: number }>(
      `SELECT owner_id FROM group_owners WHERE group_id = $1`,
      [groupId],
    );

    return result.rows[0]?.owner_id ?? null;
  }

  /**
   * Set or update the owner of a group.
   */
  async setGroupOwner(groupId: number, ownerId: number, detectedVia: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO group_owners (group_id, owner_id, detected_via, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (group_id) DO UPDATE
       SET owner_id = $2, detected_via = $3, updated_at = now()`,
      [groupId, ownerId, detectedVia],
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Payer resolution
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Resolve who pays for a message in a given chat.
   *
   * - Private chat: the user themselves.
   * - Group/supergroup: the registered group owner.
   *   If no owner is found, returns { payerId: 0, found: false }.
   */
  async resolvePayer(chatId: number, chatType: string, userId: number): Promise<{ payerId: number; found: boolean }> {
    if (chatType === 'private') {
      return { payerId: userId, found: true };
    }

    const ownerId = await this.getGroupOwner(chatId);
    if (ownerId !== null) {
      return { payerId: ownerId, found: true };
    }

    return { payerId: 0, found: false };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Coupon redemption
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Redeem a coupon for a user.
   * Returns the number of tokens credited on success, or a reason string on failure.
   */
  async redeemCoupon(userId: number, code: string): Promise<{ ok: true; tokens: number } | { ok: false; reason: string }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const couponResult = await client.query<{ tokens: number; max_uses: number; used: number }>(
        `SELECT tokens, max_uses, used FROM coupons WHERE code = $1`,
        [code],
      );

      const coupon = couponResult.rows[0];
      if (coupon === undefined) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'not_found' };
      }

      if (coupon.used >= coupon.max_uses) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'exhausted' };
      }

      const redemptionResult = await client.query(
        `SELECT 1 FROM coupon_redemptions WHERE code = $1 AND user_id = $2`,
        [code, userId],
      );

      if (redemptionResult.rows.length > 0) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'already_redeemed' };
      }

      await client.query(
        `INSERT INTO coupon_redemptions (code, user_id, tokens)
         VALUES ($1, $2, $3)`,
        [code, userId, coupon.tokens],
      );

      await client.query(
        `UPDATE coupons SET used = used + 1 WHERE code = $1`,
        [code],
      );

      await client.query(
        `INSERT INTO user_balances (user_id, tokens, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE
         SET tokens = user_balances.tokens + $2, updated_at = now()`,
        [userId, coupon.tokens],
      );

      await client.query(
        `INSERT INTO transactions (user_id, delta, action)
         VALUES ($1, $2, $3)`,
        [userId, coupon.tokens, 'coupon_redeem'],
      );

      await client.query('COMMIT');
      return { ok: true, tokens: coupon.tokens };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Tariff lookup
  // ──────────────────────────────────────────────────────────────────────────

  findTariffByStars(stars: number): TariffPackage | undefined {
    return TARIFF_PACKAGES.find(t => t.stars === stars);
  }
}
