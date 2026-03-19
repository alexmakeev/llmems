// src/__tests__/services/billing-service.test.ts
// Unit tests for BillingService — all DB calls are mocked via vi.mock('pg')

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mock objects — must be defined before vi.mock() calls (which are hoisted)
// ──────────────────────────────────────────────────────────────────────────────

const { mockClient, mockPool } = vi.hoisted(() => {
  const mockClient = {
    query: vi.fn(),
    release: vi.fn(),
  };

  const mockPool = {
    query: vi.fn(),
    connect: vi.fn().mockResolvedValue(mockClient),
    end: vi.fn().mockResolvedValue(undefined),
  };

  return { mockClient, mockPool };
});

// ──────────────────────────────────────────────────────────────────────────────
// Mock pg module — Pool constructor returns mockPool instance
// ──────────────────────────────────────────────────────────────────────────────

vi.mock('pg', () => {
  class Pool {
    constructor() {
      Object.assign(this, mockPool);
    }
  }
  return { Pool };
});

// ──────────────────────────────────────────────────────────────────────────────
// Import after mocks are set up
// ──────────────────────────────────────────────────────────────────────────────

import { BillingService, TARIFF_PACKAGES, ACTION_COSTS } from '../../services/billing-service.ts';

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function resetMocks(): void {
  vi.clearAllMocks();
  mockPool.connect.mockResolvedValue(mockClient);
  mockClient.release.mockReset();
  mockClient.query.mockReset();
  mockPool.query.mockReset();
  mockPool.end.mockResolvedValue(undefined);
}

// ──────────────────────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────────────────────

describe('BillingService', () => {
  let billing: BillingService;
  const CONNECTION_STRING = 'postgresql://localhost/test';

  beforeEach(() => {
    resetMocks();
    billing = new BillingService(CONNECTION_STRING);
  });

  // ── TARIFF_PACKAGES ─────────────────────────────────────────────────────────

  describe('TARIFF_PACKAGES', () => {
    it('contains exactly 6 packages', () => {
      expect(TARIFF_PACKAGES).toHaveLength(6);
    });

    it('starter: 60 stars, 600 tokens', () => {
      const pkg = TARIFF_PACKAGES.find(t => t.id === 'starter');
      expect(pkg).toEqual({ id: 'starter', label: 'Starter', stars: 60, tokens: 600 });
    });

    it('basic: 120 stars, 1320 tokens', () => {
      const pkg = TARIFF_PACKAGES.find(t => t.id === 'basic');
      expect(pkg).toEqual({ id: 'basic', label: 'Basic', stars: 120, tokens: 1_320 });
    });

    it('standard: 300 stars, 3600 tokens', () => {
      const pkg = TARIFF_PACKAGES.find(t => t.id === 'standard');
      expect(pkg).toEqual({ id: 'standard', label: 'Standard', stars: 300, tokens: 3_600 });
    });

    it('pro: 600 stars, 9000 tokens', () => {
      const pkg = TARIFF_PACKAGES.find(t => t.id === 'pro');
      expect(pkg).toEqual({ id: 'pro', label: 'Pro', stars: 600, tokens: 9_000 });
    });

    it('business: 1500 stars, 22500 tokens', () => {
      const pkg = TARIFF_PACKAGES.find(t => t.id === 'business');
      expect(pkg).toEqual({ id: 'business', label: 'Business', stars: 1500, tokens: 22_500 });
    });

    it('max: 3000 stars, 54000 tokens', () => {
      const pkg = TARIFF_PACKAGES.find(t => t.id === 'max');
      expect(pkg).toEqual({ id: 'max', label: 'Max', stars: 3000, tokens: 54_000 });
    });
  });

  // ── ACTION_COSTS ────────────────────────────────────────────────────────────

  describe('ACTION_COSTS', () => {
    it('text_message costs 1 token', () => {
      expect(ACTION_COSTS['text_message']).toBe(1);
    });

    it('voice_message costs 2 tokens', () => {
      expect(ACTION_COSTS['voice_message']).toBe(2);
    });

    it('search_quick costs 3 tokens', () => {
      expect(ACTION_COSTS['search_quick']).toBe(3);
    });

    it('send_html_document costs 5 tokens', () => {
      expect(ACTION_COSTS['send_html_document']).toBe(5);
    });

    it('web_research costs 25 tokens', () => {
      expect(ACTION_COSTS['web_research']).toBe(25);
    });

    it('contains exactly 5 actions', () => {
      expect(Object.keys(ACTION_COSTS)).toHaveLength(5);
    });
  });

  // ── getBalance ──────────────────────────────────────────────────────────────

  describe('getBalance', () => {
    it('returns token balance when user exists', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ tokens: 150 }] });

      const balance = await billing.getBalance(42);

      expect(balance).toBe(150);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT tokens FROM user_balances'),
        [42],
      );
    });

    it('returns 0 when user has no balance record', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const balance = await billing.getBalance(999);

      expect(balance).toBe(0);
    });
  });

  // ── creditTokens ────────────────────────────────────────────────────────────

  describe('creditTokens', () => {
    it('credits tokens and logs transaction in a transaction', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      await billing.creditTokens(42, 600, 'topup', {
        stars: 60,
        telegramPaymentChargeId: 'charge_123',
        contextId: 'ctx_1',
      });

      const calls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(calls[0]).toBe('BEGIN');

      // Second call: INSERT/UPDATE user_balances
      expect(calls[1]).toContain('INSERT INTO user_balances');
      expect(mockClient.query.mock.calls[1]![1]).toEqual([42, 600]);

      // Third call: INSERT transaction
      expect(calls[2]).toContain('INSERT INTO transactions');
      expect(mockClient.query.mock.calls[2]![1]).toEqual([42, 600, 'topup', 60, 'charge_123', 'ctx_1']);

      expect(calls[3]).toBe('COMMIT');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('passes null for optional extra fields when not provided', async () => {
      mockClient.query.mockResolvedValue({ rows: [] });

      await billing.creditTokens(42, 100, 'coupon_redeem');

      const txParams = mockClient.query.mock.calls[2]![1];
      expect(txParams).toEqual([42, 100, 'coupon_redeem', null, null, null]);
    });

    it('rolls back and rethrows on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })  // BEGIN
        .mockRejectedValueOnce(new Error('DB write failed'))  // INSERT user_balances
        .mockResolvedValueOnce({ rows: [] });  // ROLLBACK

      await expect(billing.creditTokens(42, 100, 'topup')).rejects.toThrow('DB write failed');

      const calls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(calls).toContain('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });
  });

  // ── deductTokens ────────────────────────────────────────────────────────────

  describe('deductTokens', () => {
    it('returns true and logs negative delta when balance is sufficient', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })     // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE (success)
        .mockResolvedValueOnce({ rows: [] })     // INSERT transaction
        .mockResolvedValueOnce({ rows: [] });    // COMMIT

      const result = await billing.deductTokens(42, 1, 'text_message', 'ctx_abc');

      expect(result).toBe(true);

      // Verify UPDATE query
      const updateCall = mockClient.query.mock.calls[1]!;
      expect(updateCall[0]).toContain('UPDATE user_balances');
      expect(updateCall[1]).toEqual([42, 1]);

      // Verify transaction logging with negative delta
      const txCall = mockClient.query.mock.calls[2]!;
      expect(txCall[0]).toContain('INSERT INTO transactions');
      expect(txCall[1]).toEqual([42, -1, 'text_message', 'ctx_abc']);

      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('returns false and rolls back when balance is insufficient', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })     // BEGIN
        .mockResolvedValueOnce({ rowCount: 0 })  // UPDATE (no rows matched)
        .mockResolvedValueOnce({ rows: [] });    // ROLLBACK

      const result = await billing.deductTokens(42, 100, 'text_message');

      expect(result).toBe(false);

      const calls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(calls).toContain('ROLLBACK');
      // Transaction INSERT should NOT have been called
      expect(calls.filter(c => c.includes('INSERT INTO transactions'))).toHaveLength(0);
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('passes null for contextId when not provided', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })     // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE
        .mockResolvedValueOnce({ rows: [] })     // INSERT transaction
        .mockResolvedValueOnce({ rows: [] });    // COMMIT

      await billing.deductTokens(42, 2, 'voice_message');

      const txCall = mockClient.query.mock.calls[2]!;
      expect(txCall[1]).toEqual([42, -2, 'voice_message', null]);
    });

    it('rolls back and rethrows on error', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })  // BEGIN
        .mockRejectedValueOnce(new Error('DB error'))  // UPDATE fails
        .mockResolvedValueOnce({ rows: [] });  // ROLLBACK

      await expect(billing.deductTokens(42, 1, 'text_message')).rejects.toThrow('DB error');

      const calls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(calls).toContain('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });
  });

  // ── getGroupOwner ───────────────────────────────────────────────────────────

  describe('getGroupOwner', () => {
    it('returns ownerId when group has an owner', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ owner_id: 42 }] });

      const owner = await billing.getGroupOwner(-100123);

      expect(owner).toBe(42);
      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT owner_id FROM group_owners'),
        [-100123],
      );
    });

    it('returns null when group has no owner', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const owner = await billing.getGroupOwner(-100999);

      expect(owner).toBeNull();
    });
  });

  // ── setGroupOwner ───────────────────────────────────────────────────────────

  describe('setGroupOwner', () => {
    it('inserts or upserts group owner with detected_via', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      await billing.setGroupOwner(-100123, 42, 'admin_command');

      expect(mockPool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO group_owners'),
        [-100123, 42, 'admin_command'],
      );

      // Verify upsert clause
      const sql = mockPool.query.mock.calls[0]![0] as string;
      expect(sql).toContain('ON CONFLICT (group_id) DO UPDATE');
    });
  });

  // ── resolvePayer ────────────────────────────────────────────────────────────

  describe('resolvePayer', () => {
    it('private chat: returns userId as payer', async () => {
      const result = await billing.resolvePayer(42, 'private', 42);

      expect(result).toEqual({ payerId: 42, found: true });
      // Should not query DB for private chats
      expect(mockPool.query).not.toHaveBeenCalled();
    });

    it('group with owner: returns ownerId as payer', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ owner_id: 99 }] });

      const result = await billing.resolvePayer(-100123, 'group', 42);

      expect(result).toEqual({ payerId: 99, found: true });
    });

    it('supergroup with owner: returns ownerId as payer', async () => {
      mockPool.query.mockResolvedValue({ rows: [{ owner_id: 77 }] });

      const result = await billing.resolvePayer(-100456, 'supergroup', 42);

      expect(result).toEqual({ payerId: 77, found: true });
    });

    it('group without owner: returns found:false with payerId 0', async () => {
      mockPool.query.mockResolvedValue({ rows: [] });

      const result = await billing.resolvePayer(-100123, 'group', 42);

      expect(result).toEqual({ payerId: 0, found: false });
    });
  });

  // ── redeemCoupon ────────────────────────────────────────────────────────────

  describe('redeemCoupon', () => {
    it('successful redemption: credits tokens and returns ok:true', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                           // BEGIN
        .mockResolvedValueOnce({ rows: [{ tokens: 500, max_uses: 10, used: 3 }] })    // SELECT coupon
        .mockResolvedValueOnce({ rows: [] })                                           // SELECT redemption (not found)
        .mockResolvedValueOnce({ rows: [] })                                           // INSERT coupon_redemptions
        .mockResolvedValueOnce({ rows: [] })                                           // UPDATE coupons (used + 1)
        .mockResolvedValueOnce({ rows: [] })                                           // INSERT user_balances
        .mockResolvedValueOnce({ rows: [] })                                           // INSERT transactions
        .mockResolvedValueOnce({ rows: [] });                                          // COMMIT

      const result = await billing.redeemCoupon(42, 'WELCOME50');

      expect(result).toEqual({ ok: true, tokens: 500 });

      // Verify coupon lookup
      const couponQuery = mockClient.query.mock.calls[1]!;
      expect(couponQuery[0]).toContain('SELECT tokens, max_uses, used FROM coupons');
      expect(couponQuery[1]).toEqual(['WELCOME50']);

      // Verify redemption check
      const redemptionQuery = mockClient.query.mock.calls[2]!;
      expect(redemptionQuery[0]).toContain('coupon_redemptions');
      expect(redemptionQuery[1]).toEqual(['WELCOME50', 42]);

      // Verify transaction logged with coupon_redeem action
      const txQuery = mockClient.query.mock.calls[6]!;
      expect(txQuery[0]).toContain('INSERT INTO transactions');
      expect(txQuery[1]).toEqual([42, 500, 'coupon_redeem']);

      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('coupon not found: returns reason not_found', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })  // BEGIN
        .mockResolvedValueOnce({ rows: [] })  // SELECT coupon (empty)
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const result = await billing.redeemCoupon(42, 'INVALID');

      expect(result).toEqual({ ok: false, reason: 'not_found' });
      expect(mockClient.release).toHaveBeenCalledOnce();
    });

    it('coupon exhausted: returns reason exhausted', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                        // BEGIN
        .mockResolvedValueOnce({ rows: [{ tokens: 500, max_uses: 5, used: 5 }] })  // SELECT coupon (used == max)
        .mockResolvedValueOnce({ rows: [] });                                       // ROLLBACK

      const result = await billing.redeemCoupon(42, 'USED_UP');

      expect(result).toEqual({ ok: false, reason: 'exhausted' });
    });

    it('already redeemed by this user: returns reason already_redeemed', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ tokens: 500, max_uses: 10, used: 3 }] })   // SELECT coupon
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })                        // SELECT redemption (found!)
        .mockResolvedValueOnce({ rows: [] });                                         // ROLLBACK

      const result = await billing.redeemCoupon(42, 'ALREADY_USED');

      expect(result).toEqual({ ok: false, reason: 'already_redeemed' });
    });

    it('rolls back and rethrows on DB error', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                          // BEGIN
        .mockResolvedValueOnce({ rows: [{ tokens: 500, max_uses: 10, used: 3 }] })   // SELECT coupon
        .mockResolvedValueOnce({ rows: [] })                                          // SELECT redemption
        .mockRejectedValueOnce(new Error('Insert failed'))                            // INSERT coupon_redemptions fails
        .mockResolvedValueOnce({ rows: [] });                                         // ROLLBACK

      await expect(billing.redeemCoupon(42, 'ERROR')).rejects.toThrow('Insert failed');

      const calls = mockClient.query.mock.calls.map(c => c[0] as string);
      expect(calls).toContain('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });
  });

  // ── findTariffByStars ───────────────────────────────────────────────────────

  describe('findTariffByStars', () => {
    it('finds starter tariff by 60 stars', () => {
      const tariff = billing.findTariffByStars(60);
      expect(tariff).toEqual({ id: 'starter', label: 'Starter', stars: 60, tokens: 600 });
    });

    it('finds pro tariff by 600 stars', () => {
      const tariff = billing.findTariffByStars(600);
      expect(tariff).toEqual({ id: 'pro', label: 'Pro', stars: 600, tokens: 9_000 });
    });

    it('finds max tariff by 3000 stars', () => {
      const tariff = billing.findTariffByStars(3000);
      expect(tariff).toEqual({ id: 'max', label: 'Max', stars: 3000, tokens: 54_000 });
    });

    it('returns undefined for unknown stars amount', () => {
      expect(billing.findTariffByStars(999)).toBeUndefined();
      expect(billing.findTariffByStars(0)).toBeUndefined();
      expect(billing.findTariffByStars(-1)).toBeUndefined();
    });
  });

  // ── close ───────────────────────────────────────────────────────────────────

  describe('close', () => {
    it('drains the connection pool', async () => {
      await billing.close();
      expect(mockPool.end).toHaveBeenCalledOnce();
    });
  });
});
