import os
import json
import time
import unittest
from unittest.mock import patch, MagicMock

from billing_subscriptions_python import BillingSystem, iso_now

class TestBillingSystem(unittest.TestCase):
    def setUp(self):
        os.environ["STRIPE_SECRET_KEY"] = "sk_test_dummy"
        os.environ["STRIPE_WEBHOOK_SECRET"] = "whsec_dummy"
        self.bs = BillingSystem()
        # Mock stripe
        self.patcher = patch("billing_subscriptions_python.stripe")
        self.mock_stripe = self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_create_subscription_happy_path(self):
        mock_sub = MagicMock()
        mock_sub.id = "sub_123"
        mock_sub.status = "active"
        mock_sub.current_period_end = int(time.time()) + 30 * 24 * 3600
        self.mock_stripe.Subscription.create.return_value = mock_sub

        resp = self.bs.create_subscription("cus_abc", "solo")
        self.assertTrue(resp["success"])
        self.assertEqual(resp["subscription_id"], "sub_123")
        self.assertEqual(resp["tier"], "solo")
        self.assertEqual(resp["status"], "active")
        self.assertIn("next_billing_date", resp)

        # DB record exists
        rec = self.bs.db.fetchone(
            "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?", ("sub_123",)
        )
        self.assertIsNotNone(rec)

    def test_create_subscription_invalid_tier(self):
        resp = self.bs.create_subscription("cus_abc", "gold")
        self.assertIn("error", resp)
        self.assertEqual(resp["error"], "invalid_tier")

    def test_change_plan_happy_path(self):
        # Setup existing subscription
        self.bs.db.execute(
            """
            INSERT INTO subscriptions (stripe_subscription_id, customer_id, tier, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("sub_123", "cus_abc", "solo", "active", iso_now(), iso_now()),
        )
        mock_sub = MagicMock()
        mock_sub.id = "sub_123"
        mock_sub.status = "active"
        mock_sub.current_period_start = int(time.time())
        mock_sub.proration_amounts = [{"amount": 500}]
        self.mock_stripe.Subscription.modify.return_value = mock_sub

        resp = self.bs.change_plan("sub_123", "team")
        self.assertTrue(resp["success"])
        self.assertEqual(resp["old_tier"], "solo")
        self.assertEqual(resp["new_tier"], "team")
        self.assertEqual(resp["proration_credit"], 5.0)

        # DB updated
        rec = self.bs.db.fetchone(
            "SELECT tier, status FROM subscriptions WHERE stripe_subscription_id = ?", ("sub_123",)
        )
        self.assertEqual(rec[0], "team")
        self.assertEqual(rec[1], "active")

    def test_queue_refund_happy_path(self):
        # Insert invoice
        self.bs.db.execute(
            """
            INSERT INTO invoices (stripe_invoice_id, customer_id, amount, status, paid_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("inv_123", "cus_abc", 1000, "succeeded", iso_now()),
        )
        resp = self.bs.queue_refund("inv_123", 200, "duplicate charge", "admin")
        self.assertTrue(resp["success"])
        self.assertEqual(resp["status"], "queued")
        self.assertEqual(resp["amount"], 200)

        # Refund record exists
        rec = self.bs.db.fetchone(
            "SELECT amount, status FROM refunds WHERE id = ?", (resp["refund_id"],)
        )
        self.assertEqual(rec[0], 200)
        self.assertEqual(rec[1], "queued")

    def test_queue_refund_amount_exceeds_invoice(self):
        self.bs.db.execute(
            """
            INSERT INTO invoices (stripe_invoice_id, customer_id, amount, status, paid_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            ("inv_123", "cus_abc", 1000, "succeeded", iso_now()),
        )
        resp = self.bs.queue_refund("inv_123", 1200, "overcharge", "admin")
        self.assertIn("error", resp)
        self.assertEqual(resp["error"], "refund_exceeds_invoice")

    def test_handle_webhook_payment_succeeded(self):
        payload = json.dumps(
            {
                "id": "evt_123",
                "type": "invoice.payment_succeeded",
                "data": {
                    "object": {
                        "id": "inv_123",
                        "customer": "cus_abc",
                        "amount_paid": 1000,
                    }
                },
            }
        )
        sig_header = "t=12345,v1=signature"

        # Mock signature verification
        self.mock_stripe.Webhook.construct_event.return_value = json.loads(payload)

        resp = self.bs.handle_stripe_webhook(payload, sig_header)
        self.assertTrue(resp["received"])

        # Invoice inserted
        rec = self.bs.db.fetchone(
            "SELECT stripe_invoice_id, amount FROM invoices WHERE stripe_invoice_id = ?", ("inv_123",)
        )
        self.assertIsNotNone(rec)
        self.assertEqual(rec[1], 1000)

    def test_handle_webhook_duplicate_event(self):
        # Insert event record
        self.bs.db.execute(
            "INSERT INTO events (stripe_event_id, event_type, processed_at) VALUES (?, ?, ?)",
            ("evt_123", "invoice.payment_succeeded", iso_now()),
        )
        payload = json.dumps(
            {
                "id": "evt_123",
                "type": "invoice.payment_succeeded",
                "data": {"object": {"id": "inv_123", "customer": "cus_abc", "amount_paid": 1000}},
            }
        )
        sig_header = "t=12345,v1=signature"
        self.mock_stripe.Webhook.construct_event.return_value = json.loads(payload)

        resp = self.bs.handle_stripe_webhook(payload, sig_header)
        self.assertTrue(resp["received"])

    def test_handle_webhook_subscription_updated(self):
        payload = json.dumps(
            {
                "id": "evt_456",
                "type": "customer.subscription.updated",
                "data": {
                    "object": {
                        "id": "sub_123",
                        "customer": "cus_abc",
                        "status": "active",
                        "items": {
                            "data": [
                                {
                                    "price": {"lookup_key": "team"},
                                }
                            ]
                        },
                    }
                },
            }
        )
        sig_header = "t=12345,v1=signature"
        self.mock_stripe.Webhook.construct_event.return_value = json.loads(payload)

        # Insert subscription
        self.bs.db.execute(
            """
            INSERT INTO subscriptions (stripe_subscription_id, customer_id, tier, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("sub_123", "cus_abc", "solo", "active", iso_now(), iso_now()),
        )

        resp = self.bs.handle_stripe_webhook(payload, sig_header)
        self.assertTrue(resp["received"])

        rec = self.bs.db.fetchone(
            "SELECT tier, status FROM subscriptions WHERE stripe_subscription_id = ?", ("sub_123",)
        )
        self.assertEqual(rec[0], "team")
        self.assertEqual(rec[1], "active")

    def test_webhook_signature_invalid(self):
        payload = "{}"
        sig_header = "invalid"
        self.mock_stripe.Webhook.construct_event.side_effect = stripe.error.SignatureVerificationError
        resp = self.bs.handle_stripe_webhook(payload, sig_header)
        self.assertIn("error", resp)
        self.assertEqual(resp["error"], "invalid_signature")

    def test_webhook_response_time(self):
        payload = json.dumps(
            {
                "id": "evt_789",
                "type": "invoice.payment_succeeded",
                "data": {"object": {"id": "inv_123", "customer": "cus_abc", "amount_paid": 1000}},
            }
        )
        sig_header = "t=12345,v1=signature"
        self.mock_stripe.Webhook.construct_event.return_value = json.loads(payload)

        start = time.time()
        resp = self.bs.handle_stripe_webhook(payload, sig_header)
        elapsed = time.time() - start
        self.assertTrue(elapsed < 3)
        self.assertTrue(resp["received"])

if __name__ == "__main__":
    unittest.main()