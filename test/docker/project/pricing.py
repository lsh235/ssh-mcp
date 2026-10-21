from decimal import Decimal, ROUND_HALF_UP


def invoice_total(lines, discount="0", tax="0"):
    """Calculate a total; discount and tax are rates, for example 0.10."""
    subtotal = sum(
        (Decimal(str(unit_price)) * quantity for unit_price, quantity in lines),
        Decimal("0"),
    )
    taxable = subtotal
    total = taxable * (Decimal("1") + Decimal(tax)) - subtotal * Decimal(discount)
    return total.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
