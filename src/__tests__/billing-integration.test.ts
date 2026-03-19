// src/__tests__/billing-integration.test.ts
// Integration tests for billing flows — tests the sequence of BillingService
// method calls that occur during message processing and payment handling.
// All DB calls are mocked via vi.mock('pg').

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ──────────────────────────────────────────────────────────────────────────────
// Hoisted mock objects
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
// Mock pg module
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
// Import after mocks
// ──────────────────────────────────────────────────────────────────────────────

import { BillingService, ACTION_COSTS, TARIFF_PACKAGES } from '../services/billing-service.ts';

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
// Integration Tests — Billing Flows
// ──────────────────────────────────────────────────────────────────────────────

describe('Billing Integration Flows', () => {
  let billing: BillingService;

  beforeEach(() => {
    resetMocks();
    billing = new BillingService('postgresql://localhost/test');
  });

  // ── Text message flow ───────────────────────────────────────────────────────

  describe('text message billing flow', () => {
    it('resolves payer, checks balance, deducts 1 token for text_message', async () => {
      // Step 1: resolvePayer (private chat — no DB call)
      const payer = await billing.resolvePayer(42, 'private', 42);
      expect(payer).toEqual({ payerId: 42, found: true });

      // Step 2: getBalance
      mockPool.query.mockResolvedValueOnce({ rows: [{ tokens: 100 }] });
      const balance = await billing.getBalance(payer.payerId);
      expect(balance).toBe(100);

      // Step 3: deductTokens (text_message = 1 token)
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })     // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE
        .mockResolvedValueOnce({ rows: [] })     // INSERT transaction
        .mockResolvedValueOnce({ rows: [] });    // COMMIT

      const deducted = await billing.deductTokens(
        payer.payerId,
        ACTION_COSTS['text_message']!,
        'text_message',
        'ctx_42',
      );
      expect(deducted).toBe(true);

      // Verify 1 token deducted with negative delta in transaction
      const txCall = mockClient.query.mock.calls[2]!;
      expect(txCall[1]).toEqual([42, -1, 'text_message', 'ctx_42']);
    });
  });

  // ── Voice message flow ──────────────────────────────────────────────────────

  describe('voice message billing flow', () => {
    it('deducts 2 tokens for voice_message', async () => {
      // Resolve payer
      const payer = await billing.resolvePayer(42, 'private', 42);

      // Check balance
      mockPool.query.mockResolvedValueOnce({ rows: [{ tokens: 50 }] });
      const balance = await billing.getBalance(payer.payerId);
      expect(balance).toBe(50);

      // Deduct voice_message cost
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })     // BEGIN
        .mockResolvedValueOnce({ rowCount: 1 })  // UPDATE
        .mockResolvedValueOnce({ rows: [] })     // INSERT transaction
        .mockResolvedValueOnce({ rows: [] });    // COMMIT

      const deducted = await billing.deductTokens(
        payer.payerId,
        ACTION_COSTS['voice_message']!,
        'voice_message',
      );
      expect(deducted).toBe(true);

      // Verify 2 tokens deducted
      const updateCall = mockClient.query.mock.calls[1]!;
      expect(updateCall[1]).toEqual([42, 2]);
    });
  });

  // ── Zero balance flow ──────────────────────────────────────────────────────

  describe('zero balance flow', () => {
    it('getBalance returns 0, deductTokens returns false — no processing', async () => {
      // Resolve payer
      const payer = await billing.resolvePayer(42, 'private', 42);

      // Balance is 0
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const balance = await billing.getBalance(payer.payerId);
      expect(balance).toBe(0);

      // Deduction fails
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })     // BEGIN
        .mockResolvedValueOnce({ rowCount: 0 })  // UPDATE (no rows — insufficient)
        .mockResolvedValueOnce({ rows: [] });    // ROLLBACK

      const deducted = await billing.deductTokens(payer.payerId, 1, 'text_message');
      expect(deducted).toBe(false);
    });
  });

  // ── Group without owner ────────────────────────────────────────────────────

  describe('group without owner flow', () => {
    it('resolvePayer returns found:false for group without owner', async () => {
      // No owner registered for this group
      mockPool.query.mockResolvedValueOnce({ rows: [] });

      const payer = await billing.resolvePayer(-100123, 'supergroup', 42);

      expect(payer).toEqual({ payerId: 0, found: false });
      // When found is false, caller should send activation prompt
      // (tested at telegram-bot level, here we verify the billing signal)
    });
  });

  // ── Group activation: set owner ────────────────────────────────────────────

  describe('group activation flow', () => {
    it('setGroupOwner registers owner, subsequent resolvePayer returns that owner', async () => {
      // Admin activates the bot in group
      mockPool.query.mockResolvedValueOnce({ rows: [] }); // INSERT/UPSERT
      await billing.setGroupOwner(-100123, 42, 'admin_command');

      // Now resolvePayer should find the owner
      mockPool.query.mockResolvedValueOnce({ rows: [{ owner_id: 42 }] });
      const payer = await billing.resolvePayer(-100123, 'supergroup', 99);

      expect(payer).toEqual({ payerId: 42, found: true });
    });
  });

  // ── Payment: topup via stars ────────────────────────────────────────────────

  describe('payment topup flow', () => {
    it('findTariffByStars resolves tariff, creditTokens adds correct tokens', async () => {
      // User pays 120 stars
      const tariff = billing.findTariffByStars(120);
      expect(tariff).toBeDefined();
      expect(tariff!.id).toBe('basic');
      expect(tariff!.tokens).toBe(1_320);

      // Credit tokens from payment
      mockClient.query.mockResolvedValue({ rows: [] });

      await billing.creditTokens(42, tariff!.tokens, 'topup', {
        stars: tariff!.stars,
        telegramPaymentChargeId: 'tg_charge_abc',
      });

      // Verify balance upsert with correct amount
      const balanceCall = mockClient.query.mock.calls[1]!;
      expect(balanceCall[1]).toEqual([42, 1_320]);

      // Verify transaction log with stars and charge_id
      const txCall = mockClient.query.mock.calls[2]!;
      expect(txCall[1]).toEqual([42, 1_320, 'topup', 120, 'tg_charge_abc', null]);
    });

    it('all tariff packages credit correct token amounts', async () => {
      for (const pkg of TARIFF_PACKAGES) {
        const found = billing.findTariffByStars(pkg.stars);
        expect(found).toBeDefined();
        expect(found!.tokens).toBe(pkg.tokens);
        expect(found!.id).toBe(pkg.id);
      }
    });
  });

  // ── Coupon: full redemption flow ────────────────────────────────────────────

  describe('coupon redemption flow', () => {
    it('full flow: redeem valid coupon, then verify balance increased', async () => {
      // Step 1: Redeem coupon
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                           // BEGIN
        .mockResolvedValueOnce({ rows: [{ tokens: 200, max_uses: 100, used: 5 }] })   // SELECT coupon
        .mockResolvedValueOnce({ rows: [] })                                           // SELECT redemption (none)
        .mockResolvedValueOnce({ rows: [] })                                           // INSERT coupon_redemptions
        .mockResolvedValueOnce({ rows: [] })                                           // UPDATE coupons used++
        .mockResolvedValueOnce({ rows: [] })                                           // INSERT user_balances
        .mockResolvedValueOnce({ rows: [] })                                           // INSERT transactions
        .mockResolvedValueOnce({ rows: [] });                                          // COMMIT

      const result = await billing.redeemCoupon(42, 'PROMO200');
      expect(result).toEqual({ ok: true, tokens: 200 });

      // Step 2: Check balance reflects coupon tokens
      mockPool.query.mockResolvedValueOnce({ rows: [{ tokens: 200 }] });
      const balance = await billing.getBalance(42);
      expect(balance).toBe(200);
    });

    it('invalid coupon code: returns not_found, balance unchanged', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })  // BEGIN
        .mockResolvedValueOnce({ rows: [] })  // SELECT coupon (empty)
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const result = await billing.redeemCoupon(42, 'DOESNT_EXIST');
      expect(result).toEqual({ ok: false, reason: 'not_found' });

      // Balance check: still 0 (no credit happened)
      mockPool.query.mockResolvedValueOnce({ rows: [] });
      const balance = await billing.getBalance(42);
      expect(balance).toBe(0);
    });

    it('double redemption attempt: second attempt fails with already_redeemed', async () => {
      // First redemption succeeds
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ tokens: 100, max_uses: 50, used: 10 }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const first = await billing.redeemCoupon(42, 'ONCE_ONLY');
      expect(first).toEqual({ ok: true, tokens: 100 });

      // Second redemption: user already redeemed
      resetMocks();
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })                                         // BEGIN
        .mockResolvedValueOnce({ rows: [{ tokens: 100, max_uses: 50, used: 11 }] }) // SELECT coupon
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }] })                       // SELECT redemption (found!)
        .mockResolvedValueOnce({ rows: [] });                                        // ROLLBACK

      const second = await billing.redeemCoupon(42, 'ONCE_ONLY');
      expect(second).toEqual({ ok: false, reason: 'already_redeemed' });
    });
  });

  // ── Mixed scenario: group message with billing ─────────────────────────────

  describe('group message with billing', () => {
    it('group member sends text, group owner pays', async () => {
      // User 99 sends message in group -100123, owner is user 42
      mockPool.query.mockResolvedValueOnce({ rows: [{ owner_id: 42 }] }); // getGroupOwner

      const payer = await billing.resolvePayer(-100123, 'supergroup', 99);
      expect(payer).toEqual({ payerId: 42, found: true });
      expect(payer.payerId).not.toBe(99); // Member doesn't pay

      // Check owner's balance
      mockPool.query.mockResolvedValueOnce({ rows: [{ tokens: 500 }] });
      const balance = await billing.getBalance(payer.payerId);
      expect(balance).toBe(500);

      // Deduct from owner
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const deducted = await billing.deductTokens(payer.payerId, 1, 'text_message');
      expect(deducted).toBe(true);

      // Transaction recorded against owner, not sender
      const txCall = mockClient.query.mock.calls[2]!;
      expect(txCall[1]![0]).toBe(42); // owner pays
    });
  });

  // ── Tool usage costs ───────────────────────────────────────────────────────

  describe('tool usage deduction costs', () => {
    it('search_quick deducts 3 tokens', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await billing.deductTokens(42, ACTION_COSTS['search_quick']!, 'search_quick');
      expect(result).toBe(true);

      const updateCall = mockClient.query.mock.calls[1]!;
      expect(updateCall[1]).toEqual([42, 3]);
    });

    it('web_research deducts 25 tokens', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await billing.deductTokens(42, ACTION_COSTS['web_research']!, 'web_research');
      expect(result).toBe(true);

      const updateCall = mockClient.query.mock.calls[1]!;
      expect(updateCall[1]).toEqual([42, 25]);
    });

    it('send_html_document deducts 5 tokens', async () => {
      mockClient.query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rowCount: 1 })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] });

      const result = await billing.deductTokens(42, ACTION_COSTS['send_html_document']!, 'send_html_document');
      expect(result).toBe(true);

      const updateCall = mockClient.query.mock.calls[1]!;
      expect(updateCall[1]).toEqual([42, 5]);
    });
  });
});
