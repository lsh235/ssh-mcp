import unittest
from decimal import Decimal
from pricing import invoice_total


class InvoiceTests(unittest.TestCase):
    def test_no_discount(self):
        self.assertEqual(invoice_total([(10, 2)], tax="0.20"), Decimal("24.00"))

    def test_discount_reduces_taxable_amount(self):
        self.assertEqual(
            invoice_total([(10, 2)], discount="0.10", tax="0.20"),
            Decimal("21.60"),
        )

    def test_multiple_lines(self):
        self.assertEqual(
            invoice_total([("12.50", 2), ("5.00", 1)], discount="0.20", tax="0.10"),
            Decimal("26.40"),
        )

    def test_no_tax(self):
        self.assertEqual(invoice_total([(10, 2)], discount="0.10"), Decimal("18.00"))

    def test_empty_invoice(self):
        self.assertEqual(invoice_total([], discount="0.10", tax="0.20"), Decimal("0.00"))


if __name__ == "__main__":
    unittest.main()
